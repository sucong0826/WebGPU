let sdPort = null;
let drPort = null;
let workerId = 0;
let counter = 0;
let device = null;
let commandEncoder = null;
// let renderer = null;
let hasPendingFrame = false;
let bitmap = null;
let blob = null;
let yuvBuffer = null;
let yData = null, uData = null, vData = null;

let r = Math.random();
let g = Math.random();
let b = Math.random();
let a = Math.random();

self.onmessage = function (e) {

    let entries = e.data.entries;
    let size = entries.length;
    for (let i = 0; i < size; ++i) {
        let element = entries[i];
        let cmd = element.cmd;
        let source = element.source;

        if (cmd == 'bind-sd') {
            sdPort = source;
            sdPort.onmessage = function (e) {
                if (drPort) {
                    let config = e.data.config;
                    let viewport = e.data.viewport;
                    let sourceType = config.sourceType;
                    if (sourceType == "VideoFrame") {
                        drPort.postMessage({ cmd: e.data.cmd, workerId: workerId, source: e.data.source }, [e.data.source]);
                    } else if (sourceType == "Picture") {
                        if (config.renderType == "WebGL" || config.renderType == "WebGPU") {
                            handlePictureFrame(e.data.cmd, workerId, viewport);
                        } else if (config.renderType == "WebGL2") {
                            handlePicBuffer(e.data.cmd, workerId);
                        }
                    } else if (sourceType == "ColorChunk") {
                        if (config.renderType == "WebGL2" || config.renderType == "WebGL" || config.renderType == "WebGPU") {
                            handleColorChunkBuffers(e.data.cmd, workerId, viewport);
                        } else {
                            handleColorChunkFrame(e.data.cmd, workerId, viewport);
                        }
                    }
                }
            }
        } else if (cmd == 'bind-dr') {
            drPort = source;
            drPort.onmessage = function (e) {
                // console.log("onmessage(dr)", e);
            }
        } else if (cmd == 'identify') {
            workerId = element.workerId;
            prepareBitmap();
        }
    }
};

async function prepareBitmap() {
    const resp = await fetch('../splash.jpg');
    const blob = await resp.blob();
    let imageBitmap = await createImageBitmap(blob, {
        resizeWidth: 320,
        resizeHeight: 240,
    });
    this.blob = blob;
    this.bitmap = imageBitmap;
}

function requestAnimate() {
    self.requestAnimationFrame(renderAnimationFrame);
}

function renderAnimationFrame() {
    if (renderer) {
        renderer.draw();
        requestAnimationFrame(renderAnimationFrame);
    }
}

function produceYUVColorFrame(w, h, y, u, v) {
    const width = w;
    const height = h;

    if (!yData) {
        yData = new Uint8Array(width * height);
    }

    if (!uData) {
        uData = new Uint8Array(width / 2 * height / 2);
    }
    
    if (!vData) {
        vData = new Uint8Array(width / 2 * height / 2);
    }

    // next, fill in the data
    for (let i = 0; i < yData.length; ++i) {
        yData[i] = y * 255;
    }

    for (let i = 0; i < uData.length; ++i) {
        uData[i] = u * 255;
    }

    for (let i = 0; i < vData.length; ++i) {
        vData[i] = v * 255;
    }

    // construct a VideoFrameDescriptor
    const descriptor = {
        codedWidth: width,
        codedHeight: height,
        timestamp: 0,
        format: 'I420',
        planeOffsets: [0, w * h, w * h + (width / 2 * height / 2)],
        planeStride: [w, w / 2, h / 2]
    };

    if (!yuvBuffer) {
        yuvBuffer = new Uint8Array(yData.length + uData.length + uData.length);
    }

    yuvBuffer.set(yData);
    yuvBuffer.set(uData, yData.length);
    yuvBuffer.set(vData, yData.length + uData.length);

    let frame = new VideoFrame(yuvBuffer, descriptor);
    frame.data = yuvBuffer;
    return frame;
}

function generateYUVBuffers(width, height) {
    const yData = new Uint8Array(width * height);
    const uData = new Uint8Array(width / 2 * height / 2);
    const vData = new Uint8Array(width / 2 * height / 2);

    for (let i = 0; i < yData.length; ++i) {
        yData[i] = Math.floor(Math.random() * 256); // Random Y value (0-255)
    }

    for (let i = 0; i < uData.length; ++i) {
        uData[i] = Math.floor(Math.random() * 256); // Random U value (0-255)
    }

    for (let i = 0; i < vData.length; ++i) {
        vData[i] = Math.floor(Math.random() * 256); // Random V value (0-255)
    }

    const yuvBuffers = {
        yPlane: yData.buffer,
        uPlane: uData.buffer,
        vPlane: vData.buffer,
    };

    return yuvBuffers;
}

function handleColorChunkBuffers(cmd, workerId, viewport) {
    if (counter > 30) {
        r = Math.random();
        g = Math.random();
        b = Math.random();
        a = Math.random();
        counter = 0;
    }

    counter++;
    let width = viewport.constraints.video.width;
    let height = viewport.constraints.video.height;
    let yData = new Uint8Array(width * height);
    let uData = new Uint8Array(width / 2 * height / 2);
    let vData = new Uint8Array(width / 2 * height / 2);

    // next, fill in the data
    for (let i = 0; i < yData.length; ++i) {
        yData[i] = r * 256;
    }

    for (let i = 0; i < uData.length; ++i) {
        uData[i] = g * 256;
    }

    for (let i = 0; i < vData.length; ++i) {
        vData[i] = b * 256;
    }

    const yuvBuffers = {
        yPlane: yData.buffer,
        uPlane: uData.buffer,
        vPlane: vData.buffer,
    }
    
    // const yuvBuffers = generateYUVBuffers(width, height);
    drPort.postMessage({ cmd: cmd, workerId: workerId, source: yuvBuffers }, [yData.buffer, uData.buffer, vData.buffer]);
}

function handleColorChunkFrame(cmd, workerId, viewport) {
    if (counter > 30) {
        r = Math.random();
        g = Math.random();
        b = Math.random();
        a = Math.random();
        counter = 0;
    }

    counter++;
    // let w = e.data.width;
    // let h = e.data.height;
    // const data = new Uint8Array([r * 255, g * 255, b * 255, a * 255]);
    // drPort.postMessage({ cmd: e.data.cmd, workerId: workerId, source: data.buffer }, [data.buffer]);
    // renderer.createTextureOnGPU(workerId, data);
    // drPort.postMessage({ cmd: e.data.cmd, workerId: workerId, source: tex });
    // const videoBuffer = device.createBuffer({
    //     size: 1024,
    //     usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.TEXTURE_BINDING,
    // });
    let w = viewport.constraints.video.width;
    let h = viewport.constraints.video.height;
    const vf = produceYUVColorFrame(w, h, r, g, b);
    drPort.postMessage({ cmd: cmd, workerId: workerId, source: vf }, [vf]);
}

function handlePictureFrame(cmd, workerId, viewport) {
    if (this.bitmap) {
        let w = viewport.constraints.video.width;
        let h = viewport.constraints.video.height;
        
        const descriptor = {
            codedWidth: w,
            codedHeight: h,
            timestamp: 0,
            format: 'I420',
            planeOffsets: [0, w * h, w * h + (w / 2 * h / 2)],
            planeStride: [w, w / 2, h / 2]
        };

        let picFrame = new VideoFrame(this.bitmap, descriptor);
        drPort.postMessage({ cmd: cmd, workerId: workerId, source: picFrame }, [picFrame]);
    }
}


async function handlePicBuffer(cmd, workerId) {
    if (this.blob) {
        const buffer = await this.blob.arrayBuffer();
        drPort.postMessage({ cmd: cmd, workerId: workerId, source: buffer }, [buffer]);
    }
}
