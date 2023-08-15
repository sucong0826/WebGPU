class WorkerMgr {

    // a WebGPUWorker works as a shared worker to receive messages from the CommandWorker
    // and DataWorkers. Be responsible for creating shaders, buffers, binding resources,
    // and drawing, etc.
    #renderWorker = new Worker("js/RendersWorker.js");
    #streamWorker = new Worker("js/StreamWorker.js");
    #mrChannel = null;

    // a list of data workers
    #dataWorkers = new Map();
    #numberOfDataWorker = 0;

    constructor(numberOfDataWorker) {
        this.#init(numberOfDataWorker);
    }

    #init(count) {
        this.#bindMainAndRenderWorkers();
        this.#createDataWorkers(count);
        let fpsTxt = document.getElementById('fps');
        fpsTxt.value = "0 fps";
    }

    #bindMainAndRenderWorkers() {
        if (this.#mrChannel == null) {
            this.#mrChannel = new MessageChannel();
        }
        
        this.#mrChannel.port1.onmessage = function(e) {
            // messages come from RendersWorker
            let fps = e.data.fps;
            let fpsTxt = document.getElementById('fps');
            fpsTxt.value = fps;
        }

        this.#renderWorker.postMessage({ cmd: 'bind-mr', source: this.#mrChannel.port2 }, [this.#mrChannel.port2]);
    }

    #createDataWorkers(count) {
        if (count > 0) {
            this.#numberOfDataWorker = count;
            for (let i = 0; i < count; ++i) {
                let sdChannel = new MessageChannel();
                let drChannel = new MessageChannel();
                let dataWorker = new Worker("js/DataWorker.js");

                const msg = {
                    entries: [
                        {
                            cmd: 'identify',
                            workerId: i,
                        },
                        {
                            cmd: 'bind-sd',
                            workerId: i,
                            source: sdChannel.port1,
                        },
                        {
                            cmd: 'bind-dr',
                            workerId: i,
                            source: drChannel.port1,
                        }
                    ],
                };

                dataWorker.postMessage(msg, [sdChannel.port1, drChannel.port1]);
                this.#streamWorker.postMessage({ cmd: 'bind-sd', workerId: i, source: sdChannel.port2 }, [sdChannel.port2]);
                this.#renderWorker.postMessage({ cmd: 'bind-dr', workerId: i, source: drChannel.port2 }, [drChannel.port2]);
                this.#dataWorkers.set(i, dataWorker);
            }
        }
    }

    workersStart(startInfo) {
        let offscreenCanvas = startInfo.offscreen;
        if (startInfo.config.sourceType == "VideoFrame") {
            let is = startInfo.streams.input;
            let os = startInfo.streams.output;
            this.#streamWorker.postMessage(
                { 
                    cmd: 'start',
                    config: startInfo.config,
                    viewport: startInfo.viewport,
                    streams: {
                        input: is,
                        output: os,
                    },
                }, 
                [is, os],
            );
        } else {
            this.#streamWorker.postMessage(
                { 
                    cmd: 'start',
                    config: startInfo.config,
                    viewport: startInfo.viewport,
                }, 
            );
        }

        this.#renderWorker.postMessage(
            {
                cmd: 'start',
                renderType: startInfo.config.renderType,
                sourceType: startInfo.config.sourceType,
                isMultipleTextures: startInfo.config.isMultipleTextures,
                canvas: startInfo.offscreen,
                viewport: startInfo.viewport,
            },
            [offscreenCanvas],
        );
    }

    dispatchMessage(msg) {
        let dataWorker = this.#dataWorkers.get(msg.workerId);
        if (dataWorker) {
            dataWorker.postMessage(msg, [msg.source]);
        }
    }

    createRender({renderType, canvas, viewport}) {
        webgpuRenderWorker.postMessage(
            { 
                cmd: 'createRender',
                renderType: renderType,
                canvas: canvas,
                viewport: viewport,
            },
            [ canvas ]
        );
    }

    startRender() {
        webgpuRenderWorker.postMessage(
            { 
                cmd: 'startRender',
            }
        );
    }

    test(frame) {
        let w = frame.displayWidth;
        let h = frame.displayHeight;

        if (this.#numberOfDataWorker == 1) {
            this.dispatchMessage({
                workerId: 0,
                cmd: 'buffer',
                source: frame
            });
        } else if (this.#numberOfDataWorker > 1) {
            let i = 0;
            this.dispatchMessage({
                workerId: i++,
                cmd: 'buffer',
                source: frame
            });
            
            for (; i < this.#numberOfDataWorker; ++i) {
                let yuvFrame = produceVideoFrame(w, h);
                this.dispatchMessage({
                    workerId: i,
                    cmd: 'buffer',
                    source: yuvFrame
                });
            }
        }
    }
};

export default WorkerMgr;