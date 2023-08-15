importScripts("WebGPURender.js", "WebGLRender.js", "WebGL2Render.js");

let renderer = null;
let drPort = null;
let mrPort = null;

// Rendering. Drawing is limited to once per animation frame.
let pendingFrame = null;
let startTime = null;
let frameCount = 0;
let isRendererCreated = false;
let hasPendingFrame = false;

self.onmessage = function(e) {
    //console.log("[WebGPURenderWorker] Receive msg from WorkerMgr.", e);
    let cmd = e.data.cmd;
    if (cmd == 'bind-dr') {
        drPort = e.data.source;
        drPort.onmessage = function(e) {
            handleSource(e.data.workerId, e.data.source);
        }
    } else if (cmd == "bind-mr") {
        mrPort = e.data.source;
    } else if (cmd == 'start') {
        if (!renderer) {
            let canvas = e.data.canvas;
            let viewport = e.data.viewport;
            let isMultipleTextures = e.data.isMultipleTextures;
            let sourceType = e.data.sourceType;
            let renderType = e.data.renderType;
            if (renderType == "WebGPU") {
                renderer = new WebGPURenderer(canvas, viewport, sourceType);
                renderer.prepare(isMultipleTextures);
            } else if (renderType == "WebGL") {
                renderer = new WebGLRender(canvas, viewport, sourceType);
                renderer.start();
            } else if (renderType == "WebGL2") {
                renderer = new WebGL2Render(canvas, viewport, sourceType);
                renderer.start();
            }
        }
    }
}

async function handleFrame(workerId, frame) {
    let frameBuffer = new Uint8Array(frame.allocationSize());
    await frame.copyTo(frameBuffer);
    renderer.createBuffer(workerId, frameBuffer);
    frame.close();

    if (!hasPendingFrame) {
        hasPendingFrame = true;
        requestAnimate();
    }
}

function requestAnimate() {
    self.requestAnimationFrame(renderAnimationFrame);
}
  
function renderAnimationFrame() {
    if (mrPort != null) {
        if (startTime == null) {
            startTime = performance.now();
        } else {
            const elapsed = (performance.now() - startTime) / 1000;
            const fps = ++frameCount / elapsed;
            let strFps = `${fps.toFixed(0)} fps`;
            const msg = { fps: strFps };
            mrPort.postMessage(msg);
        }
    }
    
    renderer.draw();
    requestAnimationFrame(renderAnimationFrame);
}

function bindPort(port) {
    port.onmessage = function(e) {
        // notify render to create buffer for the source
        // now we can simply regard the data as a videoframe
        let cmd = e.data.cmd;
        if (cmd == 'createBuffer') {
            if (renderer) {
                let workerId = e.data.workerId;
                renderer.createBuffer(workerId, e.data.source);
            }
        }
    }
}

function handleSource(workerId, source) {
    if (renderer) renderer.handleSource(workerId, source);
    if (!hasPendingFrame) {
        hasPendingFrame = true;
        requestAnimate();
    }
}