importScripts("WebGPURender.js", "WebGLRender.js", "WebGL2Render.js", "WebGPUDawnRenderProxy.js", "app.js");

let renderer = null;
let drPort = null;
let isRuntimeInitialized = false;
let globalCanvas = null;
let globalViewport = null;
let globalIsMultipleTextures = false;
let globalSourceType = "";

// Rendering. Drawing is limited to once per animation frame.
let pendingFrame = null;
let isRendererCreated = false;
let hasPendingFrame = false;
let result = Module.onRuntimeInitialized = () => {
    console.log('onRuntimeInitialized');
    isRuntimeInitialized = true;
    if (renderer == null) {
        if (globalCanvas != null) {
            exports.injectOffscreenCanvas(globalCanvas);
            renderer = new WebGPUDawnRenderProxy(globalCanvas, globalViewport, globalSourceType);
            renderer.start(globalIsMultipleTextures);
        }
    }
}

self.onmessage = function(e) {
    //console.log("[WebGPURenderWorker] Receive msg from WorkerMgr.", e);
    let cmd = e.data.cmd;
    if (cmd == 'bind-dr') {
        drPort = e.data.source;
        drPort.onmessage = function(e) {
            if (isRuntimeInitialized) {
                handleSource(e.data.workerId, e.data.source);
            } else {
                console.error("runtime is not initialized yet, please try again later.");
                e.data.source.close();
            }
        }
    } else if (cmd == 'start') {
        if (!renderer) {
            let canvas = e.data.canvas;
            globalCanvas = canvas;

            let viewport = e.data.viewport;
            globalViewport = viewport;

            let isMultipleTextures = e.data.isMultipleTextures;
            globalIsMultipleTextures = isMultipleTextures;

            let sourceType = e.data.sourceType;
            globalSourceType = sourceType;

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
            } if (renderType == "WebGPU-Dawn") {
                if (isRuntimeInitialized) {
                    renderer = new WebGPUDawnRenderProxy(canvas, viewport, sourceType);
                    renderer.start(isMultipleTextures);
                } else {
                    console.error("runtime is not initialized yet, please try again later.");
                }
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