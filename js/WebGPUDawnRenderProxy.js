class WebGPUDawnRenderProxy {
    #canvas = null;
    #viewport = null;
    #sourceType = "";
    #ctx = null;
    #isMultipleTextures = false;
    #width = 0;
    #height = 0;
    #yBufPtr = 0;
    #uBufPtr = 0;
    #vBufPtr = 0;

    constructor(canvas, viewport, sourceType) {
        this.#canvas = canvas;
        this.#viewport = viewport;
        this.#sourceType = sourceType;
        this.#chooseConstraints(canvas, viewport);
    }

    #chooseConstraints(canvas, viewport) {
        let maxCol = Math.ceil(Math.sqrt(viewport.streamsCounter));

        let viewportGridStrideRow = viewport.constraints.video.width;
        let viewportGridStrideCol = viewport.constraints.video.height;
        let viewportWidth = viewportGridStrideRow * maxCol;
        let viewportHeight = viewportGridStrideCol * maxCol;

        canvas.width = viewportWidth;
        canvas.height = viewportHeight;
        this.#width = viewportGridStrideRow;
        this.#height = viewportGridStrideCol;

        this.#viewport.colRow = maxCol;
        this.#viewport.viewportGridStrideRow = viewportGridStrideRow;
        this.#viewport.viewportGridStrideCol = viewportGridStrideCol;
        this.#viewport.viewportWidth = viewportWidth;
        this.#viewport.viewportHeight = viewportHeight;
    }

    #dispatchSourceToRender(workerId, source) {
        this.#readYUVPlanesDataToBuffers(source, this.#width, this.#height).then(buffers => {
            if (this.#yBufPtr == 0) {
                this.#yBufPtr = Module._malloc(buffers.yPlane.length * buffers.yPlane.BYTES_PER_ELEMENT);
            }

            if (this.#uBufPtr == 0) {
                // let uBuf = Module._malloc(buffers.uPlane.length * buffers.uPlane.BYTES_PER_ELEMENT);
                this.#uBufPtr = Module._malloc(buffers.uPlane.length * buffers.uPlane.BYTES_PER_ELEMENT);
            }
            
            if (this.#vBufPtr == 0) {
                // let vBuf = Module._malloc(buffers.vPlane.length * buffers.vPlane.BYTES_PER_ELEMENT);
                this.#vBufPtr = Module._malloc(buffers.vPlane.length * buffers.vPlane.BYTES_PER_ELEMENT);
            }
            
            Module.HEAPU8.set(buffers.yPlane, this.#yBufPtr);
            Module.HEAPU8.set(buffers.uPlane, this.#uBufPtr);
            Module.HEAPU8.set(buffers.vPlane, this.#vBufPtr);
            Module.ccall(
                'OnBufferReceived',
                'null',
                ['number', 'number', 'number', 'number', 'number', 'number', 'number'],
                [workerId, this.#yBufPtr, buffers.yPlane.byteLength, this.#uBufPtr, buffers.uPlane.byteLength, this.#vBufPtr, buffers.vPlane.byteLength]
            );
           
            // Module._free(yBuf);
            // Module._free(uBuf);
            // Module._free(vBuf);
            source.close();
        });
    }

    #readYUVPlanesDataToBuffers(videoFrame, width, height) {
        return new Promise((resolve, reject) => {
            let frameBuffer = new Uint8Array(videoFrame.allocationSize());
            videoFrame.copyTo(frameBuffer).then(() => {
                const ySize = width * height;
                const yOffset = 0;
                const uOffset = ySize;
                const uSize = width / 2 * height / 2;
                const vOffset = ySize + uSize;
    
                let yPlane = frameBuffer.subarray(yOffset, ySize);
                let uPlane = frameBuffer.subarray(uOffset, ySize + uSize);
                let vPlane = frameBuffer.subarray(vOffset, videoFrame.byteLength);
                resolve({ yPlane: yPlane, uPlane: uPlane, vPlane: vPlane });
            });
        });
    }

    start(isMultipleTextures) {
        this.#isMultipleTextures = isMultipleTextures;
        Module.ccall(
            "SetupViewport", 
            "null",
            ['number', 'number', 'number', 'number', 'number', 'number'],
            [this.#viewport.streamsCounter, this.#viewport.colRow, this.#viewport.viewportGridStrideRow, this.#viewport.viewportGridStrideCol, this.#viewport.viewportWidth, this.#viewport.viewportHeight]);
        
        Module.ccall("StartRendering", "null", ['number', 'number'], [this.#canvas.width, this.#canvas.height]);
    }

    /**
     * Handle the coming source, should be VideoFrame or YUV buffers.
     * @param {*} workerId the id of a data worker, means who dispatches this source
     * @param {*} source the data source
     */
    handleSource(workerId, source) {
        this.#dispatchSourceToRender(workerId, source);
    }

    /**
     * The proxy method for driving the renderer to draw next frame.
     */
    draw() {

    }
}