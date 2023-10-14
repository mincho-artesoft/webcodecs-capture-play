/*
Copyright (c) Meta Platforms, Inc. and affiliates.

This source code is licensed under the MIT license found in the
LICENSE file in the root directory of this source tree.
*/


const WORKER_PREFIX = "[VIDEO-DECO]";

const MAX_DECODE_QUEUE_SIZE_FOR_WARNING_MS = 500;
const MAX_QUEUED_CHUNKS_DEFAULT = 60;

importScripts('utils.js');
importScripts('ts_queue.js');

let chunk_rendered = 0;

let workerState = StateEnum.Created;

let videoDecoder = null;

let waitForKeyFrame = true;
let discardedDelta = 0;
let discardedBufferFull = 0;
let maxQueuedChunks = MAX_QUEUED_CHUNKS_DEFAULT;

// Unlike the  audio decoder video decoder tracks timestamps between input - output, so timestamps of RAW frames matches the timestamps of encoded frames

const ptsQueue = new TsQueue();

function processVideoFrame(vFrame) {
    self.postMessage({ type: "vframe", frame: vFrame, queueSize: ptsQueue.getPtsQueueLengthInfo().size, queueLengthMs: ptsQueue.getPtsQueueLengthInfo().lengthMs }, [vFrame]);
}

function setWaitForKeyframe(a) {
    waitForKeyFrame = a;
}

function isWaitingForKeyframe() {
    return waitForKeyFrame;
}

self.addEventListener('message', async function (e) {

    if (workerState === StateEnum.Created) {
        workerState = StateEnum.Instantiated;
    }

    if (workerState === StateEnum.Stopped) {
        sendMessageToMain(WORKER_PREFIX, "info", "Encoder is stopped it does not accept messages");
        return;
    }

    var type = e.data.type;
    if (type == "stop") {
        workerState = StateEnum.Stopped
        if (videoDecoder != null) {
            await videoDecoder.flush();
            videoDecoder.close();
            videoDecoder = null;

            ptsQueue.clear();
        }
        chunk_rendered = 0;
        workerState = StateEnum.Created;
    }
    else if (type == "initvideochunk") {
        if (videoDecoder != null) {
            throw "Error videoDecoder already initialized";
        }

        const videoDecoderInitCoded = e.data.init;
        if (e.data.maxQueuedChunks != undefined) {
            maxQueuedChunks = e.data.maxQueuedChunks;
        }

        // Initialize video decoder
        videoDecoder = new VideoDecoder({
            output: frame => {
                processVideoFrame(frame);
            },
            error: err => {
                sendMessageToMain(WORKER_PREFIX, "error", "Video decoder. err: " + err);
            }
        });

        videoDecoder.addEventListener("dequeue", (event) => {
            if (videoDecoder != null) {
                ptsQueue.removeUntil(videoDecoder.decodeQueueSize);
            }
        });

        let config = deSerializeMetadata(videoDecoderInitCoded);
        sendMessageToMain(WORKER_PREFIX, "info", " JSON.stringify(config)");
        sendMessageToMain(WORKER_PREFIX, "info", JSON.stringify(config));
       // config = { "codec": "avc1.42001e", "codedHeight": 180, "codedWidth": 320, "colorSpace": { "fullRange": false, "matrix": "bt709", "primaries": "bt709", "transfer": "iec61966-2-1" }, "description": {}, "hardwareAcceleration": "no-preference",  "descriptionInBase64": "AUIDDf/hABJnQsANjI1AoMvPNQENAQeEQjUBAARozjyA" }
       // config['description'] = base64ToArrayBuffer(config.descriptionInBase64);
        config.optimizeForLatency = true;
        // In my test @2022/11 with hardware accel could NOT get real time decoding, 
        // switching to soft decoding fixed everithing (h264)
        config.hardwareAcceleration = "prefer-software";
        videoDecoder.configure(config);
        sendMessageToMain(WORKER_PREFIX, "info", "JSON.stringify(config)");
        // debugger
        const { supported } = await VideoDecoder.isConfigSupported(config);
        if (supported) {
            sendMessageToMain(WORKER_PREFIX, "info", "yes"); 
        }else{
            sendMessageToMain(WORKER_PREFIX, "info", "no"); 
        }

        workerState = StateEnum.Running;
        setWaitForKeyframe(true);

        sendMessageToMain(WORKER_PREFIX, "info", "Initialized and configured");
    }
    else if (type == "videochunk") {
        sendMessageToMain(WORKER_PREFIX, "warning", type);
        if (workerState !== StateEnum.Running) {
            sendMessageToMain(WORKER_PREFIX, "warning", "Received video chunk, but NOT running state");
            return;
        }

        if (videoDecoder.decodeQueueSize >= maxQueuedChunks) {
            discardedBufferFull++;
            return;
        }

        if (discardedBufferFull > 0) {
            sendMessageToMain(WORKER_PREFIX, "warning", "Discarded " + discardedBufferFull + " video chunks because decoder buffer is full");
        }
        discardedBufferFull = 0;

        // If there is a disco, we need to wait for a new key
        if (e.data.isDisco) {
            setWaitForKeyframe(true);
        }

        // The message is video chunk
        if (isWaitingForKeyframe() && (e.data.chunk.type !== "key")) {
            // Discard Frame
            discardedDelta++;
        } else {
            if (discardedDelta > 0) {
                sendMessageToMain(WORKER_PREFIX, "warning", "Discarded " + discardedDelta + " video chunks before key");
            }
            discardedDelta = 0;
            setWaitForKeyframe(false);

            ptsQueue.removeUntil(videoDecoder.decodeQueueSize);
            ptsQueue.addToPtsQueue(e.data.chunk.timestamp, e.data.chunk.duration);
            videoDecoder.decode(e.data.chunk);
            chunk_rendered++;

            const decodeQueueInfo = ptsQueue.getPtsQueueLengthInfo();
            if (decodeQueueInfo.lengthMs > MAX_DECODE_QUEUE_SIZE_FOR_WARNING_MS) {
                sendMessageToMain(WORKER_PREFIX, "warning", "Decode queue size is " + decodeQueueInfo.lengthMs + "ms (" + decodeQueueInfo.size + " frames), videoDecoder: " + videoDecoder.decodeQueueSize);
            } else {
                sendMessageToMain(WORKER_PREFIX, "debug", "Decode queue size is " + decodeQueueInfo.lengthMs + "ms (" + decodeQueueInfo.size + " frames), videoDecoder: " + videoDecoder.decodeQueueSize);
            }
        }
    }
    else {
        sendMessageToMain(WORKER_PREFIX, "error", "Invalid message received");
    }

    return;
});
