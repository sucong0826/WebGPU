class WebGL2Render {
    #canvas = null;
    #viewport = null;
    #gl = null;
    #program = null;
    #sourceType;
    #positionAttributeLocation = 0;
    #videoTextureLocation = 0;
    #yTexLocation = 0;
    #uTexLocation = 0;
    #vTexLocation = 0;
    #positionBuffer = 0;
    #workerBufferMap = new Map();
    #workerTexMap = new Map();

    static VERTEX_SHADER = /* glsl */`#version 300 es
        in vec2 position;
        out vec2 texCoord;

        void main() {
            texCoord = (position + 1.0) * 0.5;
            gl_Position = vec4(position.x, -position.y, 0.0, 1.0);
        }
    `;

    static FRAGMENT_SHADER = /* glsl */`#version 300 es
        precision mediump float;
        in vec2 texCoord;
        uniform sampler2D videoTexture;
        out vec4 fragColor;

        void main() {
            fragColor = texture(videoTexture, texCoord);
        }
    `;

    static FRAGMENT_YUV_SHADER = /* glsl */`#version 300 es
        precision mediump float;
        in vec2 texCoord;
        uniform sampler2D yTex;
        uniform sampler2D uTex;
        uniform sampler2D vTex;
        out vec4 fragColor;

        void main() {
            // Sample Y, U, and V textures
            vec4 yuv;
            yuv.x = texture(yTex, texCoord).r;
            yuv.y = texture(uTex, texCoord).r;
            yuv.z = texture(vTex, texCoord).r;
            yuv.w = 1.0;

            // Perform YUV to RGB color space conversion
            mat4 yuvToRgb = mat4(1.1643835616, 0, 1.7927410714, -0.9729450750,
                1.1643835616, -0.2132486143, -0.5329093286, 0.3014826655,
                1.1643835616, 2.1124017857, 0, -1.1334022179,
                0, 0, 0, 1);

            vec4 rgba = yuvToRgb * yuv;

            // Combine RGB values into final color
            fragColor = rgba;
        }
    `;

    constructor(canvas, viewport, sourceType) {
        this.#canvas = canvas;
        this.#viewport = viewport;
        this.#gl = canvas.getContext("webgl2");
        this.#sourceType = sourceType;
        this.#chooseConstraints(canvas, viewport, sourceType);
    }

    start() {
        if (this.#sourceType == "ColorChunk") {
            this.#createShaderProgram(this.#gl, WebGL2Render.VERTEX_SHADER, WebGL2Render.FRAGMENT_YUV_SHADER);
            this.#positionAttributeLocation = this.#gl.getAttribLocation(this.#program, 'position');
            this.#yTexLocation = this.#gl.getUniformLocation(this.#program, 'yTexLocation');
            this.#uTexLocation = this.#gl.getUniformLocation(this.#program, 'uTexLocation');
            this.#vTexLocation = this.#gl.getUniformLocation(this.#program, 'vTexLocation');
            this.#positionBuffer = this.#createBuffer(this.#gl);

            this.#gl.bindBuffer(this.#gl.ARRAY_BUFFER, this.#positionBuffer);
            this.#gl.enableVertexAttribArray(this.#positionAttributeLocation);
            this.#gl.vertexAttribPointer(this.#positionAttributeLocation, 2, this.#gl.FLOAT, false, 0, 0);
        } else {
            this.#createShaderProgram(this.#gl, WebGL2Render.VERTEX_SHADER, WebGL2Render.FRAGMENT_SHADER);
            this.#positionAttributeLocation = this.#gl.getAttribLocation(this.#program, 'position');
            this.#videoTextureLocation = this.#gl.getUniformLocation(this.#program, 'videoTexture');
            this.#positionBuffer = this.#createBuffer(this.#gl);

            this.#gl.bindBuffer(this.#gl.ARRAY_BUFFER, this.#positionBuffer);
            this.#gl.enableVertexAttribArray(this.#positionAttributeLocation);
            this.#gl.vertexAttribPointer(this.#positionAttributeLocation, 2, this.#gl.FLOAT, false, 0, 0);
        }
    }

    cacheBuffer(workerId, buffer) {
        if (!this.#workerBufferMap.has(workerId)) {
            this.#workerBufferMap.set(workerId, frame);
        } else {
            let previousFrame = this.#workerBufferMap.get(workerId);
            if (previousFrame) previousFrame.close();
            this.#workerBufferMap.set(workerId, frame);
        }

        if (!this.#workerTexMap.has(workerId)) {
            let tex = this.#createTexture(this.#gl, frame);
            this.#workerTexMap.set(workerId, tex);
        }
    }

    async #handleSourcePromise(workerId, source) {
        return new Promise(async (resolve, reject) => {
            try {
                let buffer = null;
                if (!this.#workerBufferMap.has(workerId)) {
                    buffer = new Uint8Array(source.allocationSize());
                    await source.copyTo(buffer);
                    this.#workerBufferMap.set(workerId, buffer);
                    source.close();
                } else {
                    buffer = this.#workerBufferMap.get(workerId);
                    await source.copyTo(buffer);
                    source.close();
                }

                if (buffer) resolve(buffer);
            } catch (error) {
                reject(error);
            } finally {
                source.close();
            }
        });
    }

    handleSource(workerId, source) {
        if (this.#sourceType == "ColorChunk") {
            if (!this.#workerTexMap.has(workerId)) {
                let texGroup = this.#createTextureGroup(this.#gl, source);
                this.#workerTexMap.set(workerId, texGroup);
            } else {
                let texGroup = this.#workerTexMap.get(workerId);
                this.#updateTextureGroup(this.#gl, texGroup, source);
            }
        } else {
            if (!this.#workerTexMap.has(workerId)) {
                let tex = this.#createTexture(this.#gl, source);
                this.#workerTexMap.set(workerId, tex);
            } else {
                let tex = this.#workerTexMap.get(workerId);
                this.#updateTexture(this.#gl, tex, source);
            }
        }
    }

    draw() {
        let numberOfStream = this.#viewport.streamsCounter;
        if (numberOfStream != this.#workerTexMap.size) return;
        if (!this.#gl) return;

        this.#gl.clear(this.#gl.COLOR_BUFFER_BIT | this.#gl.DEPTH_BUFFER_BIT);
        let vpGrideStrideX = this.#viewport.viewportGridStrideRow;
        let vpGrideStrideY = this.#viewport.viewportGridStrideCol;
        let colRow = this.#viewport.colRow;

        if (this.#sourceType == "ColorChunk") {
            for (let i = 0; i < numberOfStream; ++i) {
                let texGroup = this.#workerTexMap.get(i);
                if (!texGroup) continue;
    
                const x = vpGrideStrideX * (i % colRow);
                const y = vpGrideStrideY * Math.floor(i / colRow);
                this.#gl.viewport(x, y, vpGrideStrideX, vpGrideStrideY);
                this.#gl.enable(this.#gl.DEPTH_TEST);
                this.#bindTextureGroup(this.#gl, i, texGroup);
                this.#gl.drawArrays(this.#gl.TRIANGLE_STRIP, 0, 4);
            }
        } else {
            for (let i = 0; i < numberOfStream; ++i) {
                let tex = this.#workerTexMap.get(i);
                if (!tex) continue;
    
                const x = vpGrideStrideX * (i % colRow);
                const y = vpGrideStrideY * Math.floor(i / colRow);
                this.#gl.viewport(x, y, vpGrideStrideX, vpGrideStrideY);
                this.#gl.enable(this.#gl.DEPTH_TEST);
                this.#bindTexture(this.#gl, i, tex);
                this.#gl.drawArrays(this.#gl.TRIANGLE_STRIP, 0, 4);
            }
        }
    }

    #chooseConstraints(offscreen, viewport, sourceType) {
        let maxCol = Math.ceil(Math.sqrt(viewport.streamsCounter));

        let viewportGridStrideRow = 0;
        let viewportGridStrideCol = 0;
        if (sourceType == "VideoFrame") {
            viewportGridStrideRow = viewport.constraints.video.width;
            viewportGridStrideCol = viewport.constraints.video.height;
        } else if (sourceType == "Picture" || sourceType == "ColorChunk") {
            viewportGridStrideRow = viewport.constraints.video.width;
            viewportGridStrideCol = viewport.constraints.video.height;
        }

        let viewportWidth = viewportGridStrideRow * maxCol;
        let viewportHeight = viewportGridStrideCol * maxCol;
        offscreen.width = viewportWidth;
        offscreen.height = viewportHeight;

        this.#viewport.colRow = maxCol;
        this.#viewport.viewportGridStrideRow = viewportGridStrideRow;
        this.#viewport.viewportGridStrideCol = viewportGridStrideCol;
        this.#viewport.viewportWidth = viewportWidth;
        this.#viewport.viewportHeight = viewportHeight;
    }

    #createShaderProgram(gl, vertexShaderSource, fragmentShaderSource) {
        const vertexShader = this.#createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
        const fragmentShader = this.#createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);

        this.#program = gl.createProgram();
        gl.attachShader(this.#program, vertexShader);
        gl.attachShader(this.#program, fragmentShader);
        gl.linkProgram(this.#program);

        if (!gl.getProgramParameter(this.#program, gl.LINK_STATUS)) {
            const info = gl.getProgramInfoLog(this.#program);
            throw `Could not compile WebGL program. \n\n${info}`;
        }

        gl.useProgram(this.#program);
    }

    #createShader(gl, type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const info = gl.getShaderInfoLog(shader);
            throw `Could not compile shader:\n\n${info}`;
        }
        return shader;
    }

    #createBuffer(gl) {
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        return buffer;
    }

    #createTexture(gl, videoFrame) {
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            this.#viewport.constraints.video.width,
            this.#viewport.constraints.video.height,
            0,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            videoFrame
        );
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.bindTexture(gl.TEXTURE_2D, null);
        videoFrame.close();

        return texture;
    }

    #createTextureGroup(gl, buffers) {
        let texGroup = {};
        const yPlaneTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, yPlaneTex);
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.LUMINANCE,
            this.#viewport.constraints.video.width,
            this.#viewport.constraints.video.height,
            0,
            gl.LUMINANCE,
            gl.UNSIGNED_BYTE,
            new Uint8Array(buffers.yPlane)
        );
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.bindTexture(gl.TEXTURE_2D, null);
        texGroup.yPlaneTex = yPlaneTex;

        const uPlaneTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, uPlaneTex);
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.LUMINANCE_ALPHA,
            this.#viewport.constraints.video.width / 2,
            this.#viewport.constraints.video.height / 2,
            0,
            gl.LUMINANCE_ALPHA,
            gl.UNSIGNED_BYTE,
            new Uint8Array(buffers.uPlane)
        );
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.bindTexture(gl.TEXTURE_2D, null);
        texGroup.uPlaneTex = uPlaneTex;

        const vPlaneTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, vPlaneTex);
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.LUMINANCE_ALPHA,
            this.#viewport.constraints.video.width / 2,
            this.#viewport.constraints.video.height / 2,
            0,
            gl.LUMINANCE_ALPHA,
            gl.UNSIGNED_BYTE,
            new Uint8Array(buffers.vPlane)
        );
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.bindTexture(gl.TEXTURE_2D, null);
        texGroup.vPlaneTex = vPlaneTex;

        return texGroup;
    }

    #updateTexture(gl, texture, videoFrame) {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            this.#viewport.constraints.video.width,
            this.#viewport.constraints.video.height,
            0,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            videoFrame
        );
        gl.bindTexture(gl.TEXTURE_2D, null);
        videoFrame.close();
    }

    #updateTextureGroup(gl, textureGroup, yuvBuffers) {
        gl.bindTexture(gl.TEXTURE_2D, textureGroup.yPlaneTex);
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.LUMINANCE,
            this.#viewport.constraints.video.width,
            this.#viewport.constraints.video.height,
            0,
            gl.LUMINANCE,
            gl.UNSIGNED_BYTE,
            new Uint8Array(yuvBuffers.yPlane)
        );
        gl.bindTexture(gl.TEXTURE_2D, null);

        gl.bindTexture(gl.TEXTURE_2D, textureGroup.uPlaneTex);
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.LUMINANCE_ALPHA,
            this.#viewport.constraints.video.width / 2,
            this.#viewport.constraints.video.height / 2,
            0,
            gl.LUMINANCE_ALPHA,
            gl.UNSIGNED_BYTE,
            new Uint8Array(yuvBuffers.uPlane)
        );
        gl.bindTexture(gl.TEXTURE_2D, null);

        gl.bindTexture(gl.TEXTURE_2D, textureGroup.vPlaneTex);
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.LUMINANCE_ALPHA,
            this.#viewport.constraints.video.width / 2,
            this.#viewport.constraints.video.height / 2,
            0,
            gl.LUMINANCE_ALPHA,
            gl.UNSIGNED_BYTE,
            new Uint8Array(yuvBuffers.vPlane)
        );
        gl.bindTexture(gl.TEXTURE_2D, null);
    }

    #bindTexture(gl, workerId, texture) {
        gl.activeTexture(gl.TEXTURE0 + workerId);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.uniform1i(this.#videoTextureLocation, workerId);
    }

    #bindTextureGroup(gl, workerId, textureGroup) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, textureGroup.yPlaneTex);
        gl.uniform1i(this.#yTexLocation, 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, textureGroup.uPlaneTex);
        gl.uniform1i(this.#uTexLocation, 1);

        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, textureGroup.vPlaneTex);
        gl.uniform1i(this.#vTexLocation, 2);
    }
};