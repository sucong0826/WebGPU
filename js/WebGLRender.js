class WebGLRender {
    #canvas = null;
    #viewport = null;
    #gl = null;
    #program = null;
    #sourceType;
    #positionAttributeLocation = 0;
    #videoTextureLocation = 0;
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

    constructor(canvas, viewport, sourceType) {
        this.#canvas = canvas;
        this.#viewport = viewport;
        this.#gl = canvas.getContext("webgl");
        this.#sourceType = sourceType;
        this.#chooseConstraints(canvas, viewport, sourceType);
    }

    start() {
        this.#program = this.#createShaderProgram(this.#gl, WebGLRender.VERTEX_SHADER, WebGLRender.FRAGMENT_SHADER);
        this.#positionAttributeLocation = this.#gl.getAttribLocation(this.#program, 'position');
        this.#videoTextureLocation = this.#gl.getUniformLocation(this.#program, 'videoTexture');
        this.#positionBuffer = this.#createBuffer(this.#gl);

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
        this.cacheFrame(workerId, source);
    }

    draw() {
        let numberOfStream = this.#viewport.streamsCounter;
        if (numberOfStream != this.#workerTexMap.size) return;
        if (!this.#gl) return;
        this.#gl.clear(this.#gl.COLOR_BUFFER_BIT | this.#gl.DEPTH_BUFFER_BIT);
        let vpGrideStrideX = this.#viewport.viewportGridStrideRow;
        let vpGrideStrideY = this.#viewport.viewportGridStrideCol;
        let colRow = this.#viewport.colRow;
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
};