class SingleWebGPURenderer {
  #canvas = null;
  #ctx = null;
  #textureInfo = null;

  // Promise for `#start()`, WebGPU setup is asynchronous.
  #started = null;

  // WebGPU state shared between setup and drawing.
  #format = null;
  #device = null;
  #pipeline = null;
  #sampler = null;
  #viewport = null;

  // Generates two triangles covering the whole canvas.
  static vertexShaderSource = /* wgsl */ `
      struct VertexOutput {
        @builtin(position) Position: vec4<f32>,
        @location(0) uv: vec2<f32>,
      }
  
      @vertex
      fn vert_main(@builtin(vertex_index) VertexIndex: u32) -> VertexOutput {
        var pos = array<vec2<f32>, 6>(
          vec2<f32>( 1.0,  1.0),
          vec2<f32>( 1.0, -1.0),
          vec2<f32>(-1.0, -1.0),
          vec2<f32>( 1.0,  1.0),
          vec2<f32>(-1.0, -1.0),
          vec2<f32>(-1.0,  1.0)
        );
  
        var uv = array<vec2<f32>, 6>(
          vec2<f32>(1.0, 0.0),
          vec2<f32>(1.0, 1.0),
          vec2<f32>(0.0, 1.0),
          vec2<f32>(1.0, 0.0),
          vec2<f32>(0.0, 1.0),
          vec2<f32>(0.0, 0.0)
        );
  
        var output : VertexOutput;
        output.Position = vec4<f32>(pos[VertexIndex], 0.0, 1.0);
        output.uv = uv[VertexIndex];
        return output;
      }
    `;

  // Samples the external texture using generated UVs.
  static fragmentShaderSource = /* wgsl */ `
      @group(0) @binding(1) var mySampler: sampler;
      @group(0) @binding(2) var mVideo: texture_2d<f32>;
      // @group(0) @binding(2) var myTexture: texture_external;
      //@group(0) @binding(0) var mVideo: texture_2d<f32>;
  
      @fragment
      fn frag_main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
        return textureSampleBaseClampToEdge(mVideo, mySampler, uv);
        // return textureSampleBaseClampToEdge(myTexture, mySampler, uv);
        //return textureLoad(mVideo, vec2u(uv), 1);
      }
    `;

  constructor(canvas, viewport) {
    this.#canvas = canvas;
    this.#viewport = viewport;
    this.#started = this.#start();
    this.#chooseConstraints(canvas, viewport);
  }

  prepare() {
    this.#start();
  }

  async #start() {
    const adapter = await navigator.gpu.requestAdapter();
    this.#device = await adapter.requestDevice();
    this.#format = navigator.gpu.getPreferredCanvasFormat();

    this.#ctx = this.#canvas.getContext("webgpu");
    this.#ctx.configure({
      device: this.#device,
      format: this.#format,
      alphaMode: "opaque",
    });

    this.#pipeline = this.#device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: this.#device.createShaderModule({ code: SingleWebGPURenderer.vertexShaderSource }),
        entryPoint: "vert_main"
      },
      fragment: {
        module: this.#device.createShaderModule({ code: SingleWebGPURenderer.fragmentShaderSource }),
        entryPoint: "frag_main",
        targets: [{ format: this.#format }]
      },
      primitive: {
        topology: "triangle-list"
      }
    });

    // Default sampler configuration is nearset + clamp.
    this.#sampler = this.#device.createSampler({});
  }

  stop() {
    console.log('WebGPURender stops');
  }

  createTextureOnGPU(workerId, data) {
    if (!this.#device) {
      console.error("GPUDevice is not ready!");
      return;
    }

    const texture = this.#device.createTexture({
      size: { width: 1, height: 1 },
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    this.#device.queue.writeTexture({ texture }, data, {}, { width: 1, height: 1 });

    const pendingTextureInfo = {
      index: workerId,
      texture: texture,
    };
    this.#cacheTextureInfo(pendingTextureInfo);
  }

  #cacheTextureInfo(pendingTextureInfo) {
    if (!this.#textureInfo) {
      this.#textureInfo = pendingTextureInfo;
    } else {
      if (this.#textureInfo.texture) {
        this.#textureInfo.texture.destroy();
      }
      this.#textureInfo = pendingTextureInfo;
    }
  }

  async draw() {

    if (!this.#device) return;
    if (!this.#textureInfo) return;

    const commandEncoder = this.#device.createCommandEncoder();
    const textureView = this.#ctx.getCurrentTexture().createView();
    const renderPassDescriptor = {
      colorAttachments: [
        {
          view: textureView,
          clearValue: [1.0, 0.0, 0.0, 1.0],
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    };

    const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
    passEncoder.setPipeline(this.#pipeline);
    // passEncoder.setBindGroup(0, uniformBindGroup);

    let vpGrideStrideX = this.#viewport.viewportGridStrideRow;
    let vpGrideStrideY = this.#viewport.viewportGridStrideCol;
    let vpWidth = this.#viewport.viewportWidth;
    let vpHeight = this.#viewport.viewportHeight;
    let colRow = this.#viewport.colRow;
    let index = this.#textureInfo.index;
    let tex = this.#textureInfo.texture;
    if (!tex) return;

    let texView = tex.createView();
    const uniformBindGroup = this.#device.createBindGroup({
      layout: this.#pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 1, resource: this.#sampler },
        { binding: 2, resource: texView },
      ],
    });
    passEncoder.setBindGroup(0, uniformBindGroup);

    const vpX = vpGrideStrideX * (index % colRow);
    const vpY = vpGrideStrideY * Math.floor(index / colRow);
    passEncoder.setViewport(vpX, vpY, vpGrideStrideX, vpGrideStrideY, 0, 1);
    passEncoder.draw(6, 1, 0, index);

    passEncoder.end();
    this.#device.queue.submit([commandEncoder.finish()]);
  }

  #chooseConstraints(offscreen, viewport) {
    let maxCol = Math.ceil(Math.sqrt(viewport.streamsCounter));

    let viewportGridStrideRow = viewport.constraints.video.width;
    let viewportGridStrideCol = viewport.constraints.video.height;
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
};