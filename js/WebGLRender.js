class WebGLRender {
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
    #workerFrameMap = new Map();
    #workerTexMap = new Map();

    static VERTEX_SHADER = /* glsl */`
        attribute vec2 position;
        varying vec2 texCoord;

        void main() {
            texCoord = (position + 1.0) * 0.5;
            // gl_Position = vec4(position, 0.0, 1.0);
            gl_Position = vec4(position.x, -position.y, 0.0, 1.0); // 反转y轴坐标
        }
    `;

    static FRAGMENT_SHADER = /* glsl */`
        precision mediump float;
        varying vec2 texCoord;
        uniform sampler2D videoTexture;

        void main() {
            gl_FragColor = texture2D(videoTexture, texCoord);
        }
    `;

    static FRAGMENT_YUV_SHADER = /* glsl */`
        precision mediump float;
        varying vec2 texCoord;
        uniform sampler2D yTex;
        uniform sampler2D uTex;
        uniform sampler2D vTex;

        void main() {
            // Sample Y, U, and V textures
            vec3 yuv;
            yuv.x = texture2D(yTex, texCoord).r;
            yuv.y = texture2D(uTex, texCoord).r - 0.5;
            yuv.z = texture2D(vTex, texCoord).r - 0.5;

            // Perform YUV to RGB color space conversion
            mat3 yuvToRgb = mat3(1.0, 1.0, 1.0,
                                0.0, -0.39465, 2.03211,
                                1.13983, -0.58060, 0.0);

            vec3 rgb = yuvToRgb * yuv;

            // Combine RGB values into final color
            gl_FragColor = vec4(rgb, 1.0);
        }
    `;

    constructor(canvas, viewport, sourceType) {
        this.#canvas = canvas;
        this.#viewport = viewport;
        this.#gl = canvas.getContext("webgl");
        this.#sourceType = sourceType;
        this.#chooseConstraints(canvas, viewport, sourceType);
    }

    start() {
        if (this.#sourceType == "ColorChunk") {
            this.#program = this.#createShaderProgram(this.#gl, WebGLRender.VERTEX_SHADER, WebGLRender.FRAGMENT_YUV_SHADER);
            this.#positionAttributeLocation = this.#gl.getAttribLocation(this.#program, 'position');
            this.#yTexLocation = this.#gl.getUniformLocation(this.#program, 'yTex');
            this.#uTexLocation = this.#gl.getUniformLocation(this.#program, 'uTex');
            this.#vTexLocation = this.#gl.getUniformLocation(this.#program, 'vTex');
            this.#positionBuffer = this.#createBuffer(this.#gl);
        } else {
            this.#program = this.#createShaderProgram(this.#gl, WebGLRender.VERTEX_SHADER, WebGLRender.FRAGMENT_SHADER);
            this.#positionAttributeLocation = this.#gl.getAttribLocation(this.#program, 'position');
            this.#videoTextureLocation = this.#gl.getUniformLocation(this.#program, 'videoTexture');
            this.#positionBuffer = this.#createBuffer(this.#gl);
        }

        this.#gl.useProgram(this.#program);
        this.#gl.bindBuffer(this.#gl.ARRAY_BUFFER, this.#positionBuffer);
        this.#gl.enableVertexAttribArray(this.#positionAttributeLocation);
        this.#gl.vertexAttribPointer(this.#positionAttributeLocation, 2, this.#gl.FLOAT, false, 0, 0);
    }

    cacheFrame(workerId, frame) {
        if (!this.#workerTexMap.has(workerId)) {
            let tex = this.#createTexture(this.#gl, frame);
            this.#workerTexMap.set(workerId, tex);
        } else {
            let tex = this.#workerTexMap.get(workerId);
            this.#updateTexture(this.#gl, tex, frame);
        }

        frame.close();
    }

    handleSource(workerId, source) {
        //this.cacheFrame(workerId, source);
        if (this.#sourceType == "ColorChunk") {
            if (!this.#workerTexMap.has(workerId)) {
                let texGroup = this.#createTextureGroup(this.#gl, source);
                this.#workerTexMap.set(workerId, texGroup);
            } else {
                let texGroup = this.#workerTexMap.get(workerId);
                this.#updateTextureGroup(this.#gl, texGroup, source);
            }
        } else {
            this.cacheFrame(workerId, source);
        }
    }

    draw() {
        let numberOfStream = this.#viewport.streamsCounter;
        if (numberOfStream != this.#workerTexMap.size) return;
        if (!this.#gl) return;
        this.#gl.clearColor(0.0, 0.0, 0.0, 1.0);
        this.#gl.clear(this.#gl.COLOR_BUFFER_BIT);
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
                this.#bindTextureGroup(this.#gl, texGroup);
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

        let program = gl.createProgram();
        gl.attachShader(program, vertexShader);
        gl.attachShader(program, fragmentShader);
        gl.linkProgram(program);

        return program;
    }

    #createShader(gl, type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        return shader;
    }

    #createBuffer(gl) {
        const buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        return buffer;
    }

    #createTexture(gl, frame) {
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.bindTexture(gl.TEXTURE_2D, null);
    
        return texture;
    }

    #updateTexture(gl, texture, frame) {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
        gl.bindTexture(gl.TEXTURE_2D, null);
    }

    #bindTexture(gl, workerId, texture) {
        // index should start from 0 to n
        gl.activeTexture(gl.TEXTURE0 + workerId);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.uniform1i(this.#videoTextureLocation, workerId);
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
            gl.LUMINANCE,
            this.#viewport.constraints.video.width / 2,
            this.#viewport.constraints.video.height / 2,
            0,
            gl.LUMINANCE,
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
            gl.LUMINANCE,
            this.#viewport.constraints.video.width / 2,
            this.#viewport.constraints.video.height / 2,
            0,
            gl.LUMINANCE,
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
            gl.LUMINANCE,
            this.#viewport.constraints.video.width / 2,
            this.#viewport.constraints.video.height / 2,
            0,
            gl.LUMINANCE,
            gl.UNSIGNED_BYTE,
            new Uint8Array(yuvBuffers.uPlane)
        );
        gl.bindTexture(gl.TEXTURE_2D, null);

        gl.bindTexture(gl.TEXTURE_2D, textureGroup.vPlaneTex);
        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.LUMINANCE,
            this.#viewport.constraints.video.width / 2,
            this.#viewport.constraints.video.height / 2,
            0,
            gl.LUMINANCE,
            gl.UNSIGNED_BYTE,
            new Uint8Array(yuvBuffers.vPlane)
        );
        gl.bindTexture(gl.TEXTURE_2D, null);
    }

    #bindTextureGroup(gl, textureGroup) {
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
