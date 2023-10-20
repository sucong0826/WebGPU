importScripts('./BufferManager.js');

const TEX_ACTION_WRITE_TEXTURE = 1;
const TEX_ACTION_COPY_BUF_TO_TEX = 2;

class WebGPURenderer {
  #canvas = null;
  #ctx = null;
  #workerBufferMap = new Map(/*k=workerId, v=data*/);
  #workerFrameMap = new Map();
  #workerTextureMap = new Map();
  #watermarkTexture = null;
  #drawMultipleTextures = false;
  #submitTimes = 1;
  #textureAction = 1;
  #sourceType;

  // Promise for `#start()`, WebGPU setup is asynchronous.
  #started = null;

  // WebGPU state shared between setup and drawing.
  #bufferManager = null;
  #globalCommandEncoder = null;
  #format = null;
  #device = null;
  #pipeline = null;
  #wmPipeline = null;
  #colorChunkPipeline = null;
  #sampler = null;
  #ySampler = null;
  #uSampler = null;
  #vSampler = null;
  #viewport = null;

  // Generates two triangles covering the whole canvas.
  static VERTEX_SHADER = /* wgsl */ `
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
  static FRAG_SHADER_VF = /* wgsl */ `
    @group(0) @binding(0) var mySampler: sampler;
    @group(0) @binding(1) var vfTexture: texture_external;

    @fragment
    fn frag_main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
      var color0: vec4<f32> = textureSampleBaseClampToEdge(vfTexture, mySampler, uv);
      return color0;
    }
  `;

  static FRAG_SHADER_YUV = /* wgsl */ `
    @group(0) @binding(0) var ySampler: sampler;
    @group(0) @binding(1) var uSampler: sampler;
    @group(0) @binding(2) var vSampler: sampler;
    @group(0) @binding(3) var yTexture: texture_2d<f32>;
    @group(0) @binding(4) var uTexture: texture_2d<f32>;
    @group(0) @binding(5) var vTexture: texture_2d<f32>;

    @fragment
    fn frag_main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
      //var rgba: vec4<f32>;
      // rgba.r = textureSampleBaseClampToEdge(yTexture, mySampler, uv).r;
      // rgba.g = textureSampleBaseClampToEdge(uTexture, mySampler, uv).r;
      // rgba.b = textureSampleBaseClampToEdge(vTexture, mySampler, uv).r;
      // rgba.a = 1.0;
      let y = textureSampleBaseClampToEdge(yTexture, ySampler, uv).r;
      let u = textureSampleBaseClampToEdge(uTexture, uSampler, uv).r;
      let v = textureSampleBaseClampToEdge(vTexture, vSampler, uv).r;
      
      let yuv_2_rgb_matrix = mat4x4(
        1.1643835616, 0, 1.7927410714, -0.9729450750,
        1.1643835616, -0.2132486143, -0.5329093286, 0.3014826655,
        1.1643835616, 2.1124017857, 0, -1.1334022179,
        0, 0, 0, 1);

      return vec4<f32>(y, u, v, 1.0) * yuv_2_rgb_matrix;
      // let yuv2rgba = mat4x4(
      //   1.1643828125, 0, 1.59602734375, -.87078515625,
      //   1.1643828125, -.39176171875, -.81296875, .52959375,
      //   1.1643828125, 2.017234375, 0, -1.081390625,
      //   0, 0, 0, 1
      // );

      // return yuv2rgba * vec4<f32>(y, u, v, 1.0);
      // var yuvToRgb = mat3x3(1.0, 1.0, 1.0, 0.0, -0.39465, 2.03211, 1.13983, -0.58060, 0.0);
      // rgb.r = y + 1.13983 * v;
      // rgb.g = y - 0.39465 * u - 0.58060 * v;
      // rgb.b = y + 2.03211 * u;
      // // var rgb: vec3<f32> = yuvToRgb * rgba.rgb;
      // var yuv2rgb = mat3x3(
      //   1, 0, 1.5784,
      //   1, -0.8173, -0.4681,
      //   1, 1.8556, 0
      // );
      // let rgb = yuv2rgb * vec3<f32>(y, u, v);
      // return vec4<f32>(rgb, 1.0);

      // var yuvToRgb = mat3x3(1.0, 1.0, 1.0, 0.0, -0.39465, 2.03211, 1.13983, -0.58060, 0.0);
      // var rgb: vec3<f32> = yuvToRgb * vec3<f32>(y, u, v);
      // return vec4<f32>(rgb, 1.0);
    }
  `;

  static FRAG_SHADER_COLORCHUNK = /* wgsl */ `
    @group(0) @binding(0) var mySampler: sampler;
    @group(0) @binding(1) var yTexture: texture_2d<f32>;
    @group(0) @binding(2) var uTexture: texture_2d<f32>;
    @group(0) @binding(3) var vTexture: texture_2d<f32>;
    // @group(0) @binding(4) var<storage, read_write> outputBuffer: array<f32>;

    @fragment
    fn frag_main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
      let y = textureSampleBaseClampToEdge(yTexture, mySampler, uv).r;
      let u = textureSampleBaseClampToEdge(uTexture, mySampler, uv).r;
      let v = textureSampleBaseClampToEdge(vTexture, mySampler, uv).r;
      
      let yuv_2_rgb_matrix = mat4x4(
        1.1643835616, 0, 1.7927410714, -0.9729450750,
        1.1643835616, -0.2132486143, -0.5329093286, 0.3014826655,
        1.1643835616, 2.1124017857, 0, -1.1334022179,
        0, 0, 0, 1);
      
     
      let color = vec4<f32>(y, u, v, 1.0) * yuv_2_rgb_matrix;
      // outputBuffer[0] = y;
      // outputBuffer[1] = u;
      // outputBuffer[2] = v;
      // outputBuffer[3] = color.r;
      // outputBuffer[4] = color.g;
      // outputBuffer[5] = color.b;
      // outputBuffer[6] = color.a;
      return color;
    }
  `;

  static FRAG_SHADER_PIC = /* wgsl */ `
    @group(0) @binding(0) var mySampler: sampler;
    @group(0) @binding(1) var vfTexture: texture_external;
    //@group(0) @binding(1) var picTexture: texture_2d<f32>;

    @fragment
    fn frag_main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
      var color0: vec4<f32> = textureSampleBaseClampToEdge(vfTexture, mySampler, uv);
      return color0;
    }
  `;

  static watermarkShaderSource = /* wgsl */ `
    @group(0) @binding(0) var mySampler: sampler;
    @group(0) @binding(1) var myWmTexture: texture_2d<f32>;

    struct VertexOutput {
      @builtin(position) Position: vec4<f32>,
      @location(0) uv: vec2<f32>,
    };

    @vertex
    fn v_main(
      @builtin(vertex_index) VertexIndex: u32,
      @location(0) pos: vec2<f32>,
      @location(1) uvPos: vec2<f32>
    ) -> VertexOutput {

      var output: VertexOutput;
      output.Position = vec4<f32>(pos, 0.0, 1.0);
      output.uv = uvPos;
      // output.uv = uv[VertexIndex];
      return output;
    }

    @fragment
    fn f_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
      var color: vec4<f32> = textureSampleBaseClampToEdge(myWmTexture, mySampler, uv);
      // return vec4<f32>(color.rgb,);
      color.a *= 0.8;
      return color;
    }
  `;

  constructor(canvas, viewport, sourceType) {
    this.#canvas = canvas;
    this.#viewport = viewport;
    this.#started = this.#start();
    this.#sourceType = sourceType;
    this.#chooseConstraints(canvas, viewport, sourceType);
  }

  prepare(drawMultipleTextures, submitTimes, textureAction) {
    this.#drawMultipleTextures = drawMultipleTextures;
    this.#submitTimes = submitTimes;
    this.#textureAction = textureAction;
    this.#start();
  }

  async #start() {
    const adapter = await navigator.gpu.requestAdapter();
    this.#device = await adapter.requestDevice();
    this.#format = navigator.gpu.getPreferredCanvasFormat();
    this.#bufferManager = new BufferManager(this.#device);

    this.#ctx = this.#canvas.getContext("webgpu");
    this.#ctx.configure({
      device: this.#device,
      format: this.#format,
      alphaMode: "opaque",
    });

    let fragShaderSource = WebGPURenderer.FRAG_SHADER_VF;
    if (this.#sourceType == "VideoFrame") {
      //fragShaderSource = WebGPURenderer.FRAG_SHADER_YUV;
      fragShaderSource = WebGPURenderer.FRAG_SHADER_VF;
      this.#pipeline = this.#device.createRenderPipeline({
        layout: "auto",
        vertex: {
          module: this.#device.createShaderModule({ code: WebGPURenderer.VERTEX_SHADER }),
          entryPoint: "vert_main"
        },
        fragment: {
          module: this.#device.createShaderModule({ code: fragShaderSource }),
          entryPoint: "frag_main",
          targets: [
            { 
              format: this.#format,
            }
          ]
        },
        primitive: {
          topology: "triangle-list"
        }
      });
    } else if (this.#sourceType == "Picture") {
      fragShaderSource = WebGPURenderer.FRAG_SHADER_VF;
      this.#pipeline = this.#device.createRenderPipeline({
        layout: "auto",
        vertex: {
          module: this.#device.createShaderModule({ code: WebGPURenderer.VERTEX_SHADER }),
          entryPoint: "vert_main"
        },
        fragment: {
          module: this.#device.createShaderModule({ code: fragShaderSource }),
          entryPoint: "frag_main",
          targets: [{ format: this.#format }]
        },
        primitive: {
          topology: "triangle-list"
        }
      });
    } else if (this.#sourceType == "ColorChunk") {
      fragShaderSource = WebGPURenderer.FRAG_SHADER_COLORCHUNK;
      this.#colorChunkPipeline = this.#device.createRenderPipeline({
        layout: "auto",
        vertex: {
          module: this.#device.createShaderModule({ code: WebGPURenderer.VERTEX_SHADER }),
          entryPoint: "vert_main"
        },
        fragment: {
          module: this.#device.createShaderModule({ code: fragShaderSource }),
          entryPoint: "frag_main",
          targets: [{ format: this.#format }]
        },
        primitive: {
          topology: "triangle-list"
        }
      });
    }

    // Default sampler configuration is nearset + clamp.
    this.#sampler = this.#device.createSampler({});
    this.#ySampler = this.#device.createSampler(
      {
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
        magFilter: "linear",
        minFilter: "linear",
        mipmapFilter: "linear",
      }
    );

    this.#uSampler = this.#device.createSampler(
      {
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
        magFilter: "linear",
        minFilter: "linear",
        mipmapFilter: "linear",
      }
    );

    this.#vSampler = this.#device.createSampler(
      {
        addressModeU: "clamp-to-edge",
        addressModeV: "clamp-to-edge",
        magFilter: "linear",
        minFilter: "linear",
        mipmapFilter: "linear",
      }
    );

    if (this.#drawMultipleTextures) {
      this.#wmPipeline = this.#device.createRenderPipeline({
        layout: "auto",
        vertex: {
          module: this.#device.createShaderModule({ code: WebGPURenderer.watermarkShaderSource }),
          entryPoint: "v_main",
          buffers: [
            {
              arrayStride: 2 * 4,
              attributes: [
                {
                  shaderLocation: 0,
                  format: "float32x2",
                  offset: 0,
                },
              ]
            },
            {
              arrayStride: 2 * 4,
              attributes: [
                {
                  shaderLocation: 1,
                  format: "float32x2",
                  offset: 0,
                },
              ]
            }
          ],
        },
        fragment: {
          module: this.#device.createShaderModule({ code: WebGPURenderer.watermarkShaderSource }),
          entryPoint: "f_main",
          targets: [
            {
              format: this.#format,
              blend: {
                alpha: {
                  srcFactor: 'src-alpha',
                  dstFactor: 'dst-alpha',
                  operation: 'add',
                },
                color: {
                  srcFactor: 'src',
                  dstFactor: 'dst',
                  operation: 'add',
                },
              },
            }
          ]
        },
        primitive: {
          topology: "triangle-list"
        },
      });

      this.#createWatermarkTexture();
    }
  }

  stop() {
    console.log('WebGPURender stops');
    for (const [key, val] of this.#workerFrameMap) {
      val.close();
    }
    this.#workerFrameMap.clear();

    for (const [key, val] of this.#workerTextureMap) {
      val.yTex.destroy();
      val.uTex.destroy();
      val.vTex.destroy();
    }
    this.#workerTextureMap.clear();
  }

  cacheFrame(workerId, frame) {
    if (!this.#workerFrameMap.has(workerId)) {
      this.#workerFrameMap.set(workerId, frame);
    } else {
      let previousFrame = this.#workerFrameMap.get(workerId);
      if (previousFrame) previousFrame.close();
      this.#workerFrameMap.set(workerId, frame);
    }
  }

  #cacheTextureGroup(workerId, buffers) {
    if (!this.#device || !this.#bufferManager) return;
    // this.#workerTextureMap.set(workerId, buffers);
    
    const width = this.#viewport.viewportGridStrideRow;
    const height = this.#viewport.viewportGridStrideCol;
    // const commandEncoder = this.#device.createCommandEncoder();
    const commandEncoder = this.#acquireGlobalCommandEncoder();

    let texGroup = null;
    if (this.#workerTextureMap.has(workerId)) {
      texGroup = this.#workerTextureMap.get(workerId);
      if (texGroup) {
        texGroup = this.#updateYUVPlanesTexturesWith(workerId, this.#textureAction, width, height, buffers, commandEncoder, texGroup);
      } else {
        texGroup = this.#updateYUVPlanesTexturesWith(workerId, this.#textureAction, width, height, buffers, commandEncoder);
      }
    } else {
      texGroup = this.#updateYUVPlanesTexturesWith(workerId, this.#textureAction, width, height, buffers, commandEncoder);
    }

    if (texGroup) {
      this.#workerTextureMap.set(workerId, texGroup);
    } else {
      console.warn(`texGroup is invalid, workerId=${workerId}`);
    }
  }

  cacheTexture(workerId, texture) {
    if (!this.#workerTextureMap.has(workerId)) {
      this.#workerTextureMap.set(workerId, texture);
    } else {
      let previousTex = this.#workerTextureMap.get(workerId);
      if (previousTex) previousTex.destroy();
      this.#workerTextureMap.set(workerId, texture);
    }
  }

  createTexture(workerId, width, height, data) {
    if (!this.#device) return;
    // console.log("[WebGPURender] ready to create a texture from a frame.");

    const texture = this.#device.createTexture({
      size: { width: width, height: height },
      format: this.#format,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    this.#device.queue.writeTexture(
      { aspect: "all", texture: texture },
      data,
      { bytesPerRow: width * 4 },
      { width: width, height: height },
    );

    this.cacheTexture(workerId, texture);
  }

  handleSource(workerId, source) {
    if (this.#sourceType == "VideoFrame") {
      this.cacheFrame(workerId, source);
      // this.#cacheTextureGroup(workerId, source);
    } else if (this.#sourceType == "Picture") {
      this.cacheFrame(workerId, source);
    } else if (this.#sourceType == "ColorChunk") {
      // this.cacheFrame(workerId, source);
      this.#cacheTextureGroup(workerId, source);
    }
  }

  async #createWatermarkTexture() {
    const resp = await fetch('../pic.jpg');
    const blob = await resp.blob();
    const imageBitmap = await createImageBitmap(blob);

    const texture = this.#device.createTexture({
      size: [imageBitmap.width, imageBitmap.height, 1],
      format: this.#format,
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.SAMPLED | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    this.#device.queue.copyExternalImageToTexture(
      { source: imageBitmap },
      { texture: texture },
      [imageBitmap.width, imageBitmap.height],
    );

    this.#watermarkTexture = texture;
  }

  #createPictureTexture(workerId, imageBitmap) {
    if (!this.#device) return;
    const texture = this.#device.createTexture({
      size: [imageBitmap.width, imageBitmap.height, 1],
      format: this.#format,
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.SAMPLED | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    this.#device.queue.copyExternalImageToTexture(
      { source: imageBitmap },
      { texture: texture },
      [imageBitmap.width, imageBitmap.height],
    );

    this.cacheTexture(workerId, texture);
    imageBitmap.close();
  }

  draw() {
    if (this.#sourceType == "ColorChunk") {
      this.#drawColorChunk();
    } else if (this.#sourceType == "VideoFrame") {
      this.#drawVideoFrame();
      // this.#drawVideoFrameYUVBuffers();
    } else if (this.#sourceType == "Picture") {
      this.#drawPicture();
    }
  }

  #drawColorChunk() {
    if (this.#submitTimes === 1) {
      this.#drawColorChunkWithOneTimeSubmit();
    } else {
      this.#drawColorChunkWithMultipleTimesSubmit();
    }
  }

  #drawColorChunkWithOneTimeSubmit() {
    if (!this.#device) return;
    let numberOfStream = this.#viewport.streamsCounter;
    if (numberOfStream != this.#workerTextureMap.size) return;

    // const commandEncoder = this.#device.createCommandEncoder();
    const commandEncoder = this.#acquireGlobalCommandEncoder();
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

    let vpGrideStrideX = this.#viewport.viewportGridStrideRow;
    let vpGrideStrideY = this.#viewport.viewportGridStrideCol;

    // const outputBuffer = this.#device.createBuffer({
    //   size: 512 * vpGrideStrideY,
    //   usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    // });

    // const outputStagingBuffer = this.#device.createBuffer({
    //   size: 512 * vpGrideStrideY,
    //   usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    // });

    // let buffers = this.#workerTextureMap.get(0);
    // const textureGroup = this.#createYUVPlanesTexturesWith(this.#textureAction, vpGrideStrideX, vpGrideStrideY, buffers, textureCommandEncoder);

    // this.#device.pushErrorScope('validation');

    const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
    passEncoder.setPipeline(this.#colorChunkPipeline);
    //let vpGrideStrideX = this.#viewport.viewportGridStrideRow;
    //let vpGrideStrideY = this.#viewport.viewportGridStrideCol;
    let colRow = this.#viewport.colRow;

    for (let i = 0; i < numberOfStream; ++i) {
      let uniformBindGroup = null;
      // let buffers = this.#workerTextureMap.get(i);
      // if (!buffers) continue;

      let textureGroup = this.#workerTextureMap.get(i);
      if (!textureGroup) continue;

      // const textureGroup = this.#createYUVPlanesTexturesWith(this.#textureAction, vpGrideStrideX, vpGrideStrideY, buffers, textureCommandEncoder);
      uniformBindGroup = this.#device.createBindGroup({
        layout: this.#colorChunkPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.#sampler },
          { binding: 1, resource: textureGroup.yTex.createView() },
          { binding: 2, resource: textureGroup.uTex.createView() },
          { binding: 3, resource: textureGroup.vTex.createView() },
          // { binding: 4, resource: { buffer: outputBuffer } }
        ],
      });

      if (!uniformBindGroup) continue;
      passEncoder.setBindGroup(0, uniformBindGroup);
      const vpX = vpGrideStrideX * (i % colRow);
      const vpY = vpGrideStrideY * Math.floor(i / colRow);
      passEncoder.setViewport(vpX, vpY, vpGrideStrideX, vpGrideStrideY, 0, 1);
      passEncoder.draw(6, 1, 0, 0);
    }
    passEncoder.end();

    // commandEncoder.copyBufferToBuffer(
    //   outputBuffer, 
    //   0, 
    //   outputStagingBuffer, 
    //   0, 
    //   512,
    // );

    // this.#device.queue.submit([commandEncoder.finish()]);
    this.#submit();

    // await outputStagingBuffer.mapAsync(GPUMapMode.READ, 0, 512 * vpGrideStrideY);
    // const copyArrayBuffer = outputStagingBuffer.getMappedRange(0, 512 * vpGrideStrideY);
    // const data = copyArrayBuffer.slice();
    // outputStagingBuffer.unmap();
    // console.log(new Float32Array(data));

    // this.#device.popErrorScope().then((error) => {
    //   if (error) {
    //     console.error(`An error occured while rendering: ${error.message}`);
    //   }
    // });
  }

  #drawColorChunkWithMultipleTimesSubmit() {
    let numberOfStream = this.#viewport.streamsCounter;
    if (!this.#device) return;
    if (!this.#sourceType || this.#sourceType == "") return;
    if (numberOfStream != this.#workerTextureMap.size) return;

    let vpGrideStrideX = this.#viewport.viewportGridStrideRow;
    let vpGrideStrideY = this.#viewport.viewportGridStrideCol;
    let colRow = this.#viewport.colRow;

    for (let i = 0; i < numberOfStream; ++i) {
      const vpX = vpGrideStrideX * (i % colRow);
      const vpY = vpGrideStrideY * Math.floor(i / colRow);
      this.#drawColorChunkByIndex(i, vpX, vpY, vpGrideStrideX, vpGrideStrideY);
    }
  }

  #drawColorChunkByIndex(index, x, y, w, h) {
    const commandEncoder = this.#device.createCommandEncoder();
    const textureView = this.#ctx.getCurrentTexture().createView();
    const renderPassDescriptor = {
      colorAttachments: [
        {
          view: textureView,
          clearValue: [1.0, 0.0, 0.0, 1.0],
          loadOp: "load",
          storeOp: "store",
        },
      ],
    };

    const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
    passEncoder.setPipeline(this.#colorChunkPipeline);

    let uniformBindGroup = null;
    if (this.#sourceType == "VideoFrame" || this.#sourceType == "ColorChunk" || this.#sourceType == "Picture") {
      let buffers = this.#workerTextureMap.get(index);
      if (!buffers) return;

      const textureGroup = this.#updateYUVPlanesTexturesWith(this.#textureAction, w, h, buffers, commandEncoder);
      uniformBindGroup = this.#device.createBindGroup({
        layout: this.#colorChunkPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.#sampler },
          { binding: 1, resource: textureGroup.yTex.createView() },
          { binding: 2, resource: textureGroup.uTex.createView() },
          { binding: 3, resource: textureGroup.vTex.createView() },
        ],
      });
    }

    if (!uniformBindGroup) return;
    passEncoder.setBindGroup(0, uniformBindGroup);
    passEncoder.setViewport(x, y, w, h, 0, 1);
    passEncoder.draw(6, 1, 0, 0);
    passEncoder.end();
    this.#device.queue.submit([commandEncoder.finish()]);
  }
  
  #drawVideoFrameYUVBuffers() {
    if (!this.#device) return;
    let numberOfStream = this.#viewport.streamsCounter;
    if (numberOfStream != this.#workerTextureMap.size) return;

    const commandEncoder = this.#device.createCommandEncoder();
    const textureView = this.#ctx.getCurrentTexture().createView();
    const renderPassDescriptor = {
      colorAttachments: [
        {
          view: textureView,
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    };

    const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
    passEncoder.setPipeline(this.#pipeline);
    let vpGrideStrideX = this.#viewport.viewportGridStrideRow;
    let vpGrideStrideY = this.#viewport.viewportGridStrideCol;
    let colRow = this.#viewport.colRow;

    for (let i = 0; i < numberOfStream; ++i) {
      let uniformBindGroup = null;
      let buffers = this.#workerTextureMap.get(i);
      if (!buffers) continue;
      const textureGroup = this.#updateYUVPlanesTexturesWith(this.#textureAction, vpGrideStrideX, vpGrideStrideY, buffers, commandEncoder);

      uniformBindGroup = this.#device.createBindGroup({
        layout: this.#pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.#ySampler },
          { binding: 1, resource: this.#uSampler },
          { binding: 2, resource: this.#vSampler },
          { binding: 3, resource: textureGroup.yTex.createView() },
          { binding: 4, resource: textureGroup.uTex.createView() },
          { binding: 5, resource: textureGroup.vTex.createView() },
        ],
      });

      if (!uniformBindGroup) continue;
      passEncoder.setBindGroup(0, uniformBindGroup);
      const vpX = vpGrideStrideX * (i % colRow);
      const vpY = vpGrideStrideY * Math.floor(i / colRow);
      passEncoder.setViewport(vpX, vpY, vpGrideStrideX, vpGrideStrideY, 0, 1);
      passEncoder.draw(6, 1, 0, i);
    }
    passEncoder.end();
    this.#device.queue.submit([commandEncoder.finish()]);
  }

  #drawVideoFrameWithOneTimeSubmit() {
    let numberOfStream = this.#viewport.streamsCounter;
    if (!this.#device) return;
    if (!this.#sourceType || this.#sourceType == "") return;
    if (numberOfStream != this.#workerFrameMap.size) return;
    
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

    let vpGrideStrideX = this.#viewport.viewportGridStrideRow;
    let vpGrideStrideY = this.#viewport.viewportGridStrideCol;
    let colRow = this.#viewport.colRow;

    for (let i = 0; i < numberOfStream; ++i) {
      let uniformBindGroup = null;
      if (this.#sourceType == "VideoFrame" || this.#sourceType == "ColorChunk" || this.#sourceType == "Picture") {
        let frame = this.#workerFrameMap.get(i);
        if (!frame) continue;

        uniformBindGroup = this.#device.createBindGroup({
          layout: this.#pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.#sampler },
            { binding: 1, resource: this.#device.importExternalTexture({ source: frame }) },
          ],
        });
      }

      if (!uniformBindGroup) continue;
      passEncoder.setBindGroup(0, uniformBindGroup);
      const vpX = vpGrideStrideX * (i % colRow);
      const vpY = vpGrideStrideY * Math.floor(i / colRow);
      passEncoder.setViewport(vpX, vpY, vpGrideStrideX, vpGrideStrideY, 0, 1);
      passEncoder.draw(6, 1, 0, 0);
    }
    passEncoder.end();

    if (this.#drawMultipleTextures && this.#watermarkTexture) {
      const wmCmdEncoder = this.#device.createCommandEncoder();
      const currentTexView = this.#ctx.getCurrentTexture().createView();
      const wmRenderPassDescriptor = {
        colorAttachments: [
          {
            view: currentTexView,
            loadOp: "load",
            storeOp: "store",
          },
        ],
        // depthStencilAttachment: {
        //   depthClearValue: 0,
        //   depthLoadOp: "load",
        //   depthStoreOp: "store"
        // },
      };

      // start to draw watermark
      // 1. create vertex buffers
      const vtxPosArray = new Float32Array([
        1.0 / 2, 1.0 / 2,
        1.0 / 2, -1.0 / 2,
        -1.0 / 2, -1.0 / 2,
        1.0 / 2, 1.0 / 2,
        -1.0 / 2, -1.0 / 2,
        -1.0 / 2, 1.0 / 2,
      ]);

      const vtxPosBuffer = this.#device.createBuffer({
        size: vtxPosArray.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE,
        mappedAtCreation: true,
      });

      new Float32Array(vtxPosBuffer.getMappedRange()).set(vtxPosArray);
      vtxPosBuffer.unmap();

      // 2. create uv buffers
      const vtxUVArray = new Float32Array([
        1.0 / 2, 0.0 / 2,
        1.0 / 2, 1.0 / 2,
        0.0 / 2, 1.0 / 2,
        1.0 / 2, 0.0 / 2,
        0.0 / 2, 1.0 / 2,
        0.0 / 2, 0.0 / 2,
      ]);

      const vtxUVBuffer = this.#device.createBuffer({
        size: vtxUVArray.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE,
        mappedAtCreation: true,
      });

      new Float32Array(vtxUVBuffer.getMappedRange()).set(vtxUVArray);
      vtxUVBuffer.unmap();

      const wmPassEncoder = wmCmdEncoder.beginRenderPass(wmRenderPassDescriptor);
      wmPassEncoder.setVertexBuffer(0, vtxPosBuffer);
      wmPassEncoder.setVertexBuffer(1, vtxUVBuffer);
      wmPassEncoder.setPipeline(this.#wmPipeline);
      let wmTextureView = this.#watermarkTexture.createView();
      let wmBindGroup = this.#device.createBindGroup({
        layout: this.#wmPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.#sampler },
          { binding: 1, resource: wmTextureView },
        ],
      });
      wmPassEncoder.setBindGroup(0, wmBindGroup);
      wmPassEncoder.draw(6, 1, 0, 0);
      wmPassEncoder.end();
      this.#device.queue.submit([commandEncoder.finish(), wmCmdEncoder.finish()]);
    } else {
      this.#device.queue.submit([commandEncoder.finish()]);
    }
  }

  #drawVideoFrameWithMultipleTimesSubmit() {
    let numberOfStream = this.#viewport.streamsCounter;
    if (!this.#device) return;
    if (!this.#sourceType || this.#sourceType == "") return;
    if (numberOfStream != this.#workerFrameMap.size) return;

    let vpGrideStrideX = this.#viewport.viewportGridStrideRow;
    let vpGrideStrideY = this.#viewport.viewportGridStrideCol;
    let colRow = this.#viewport.colRow;

    for (let i = 0; i < numberOfStream; ++i) {
      const vpX = vpGrideStrideX * (i % colRow);
      const vpY = vpGrideStrideY * Math.floor(i / colRow);
      this.#drawVideoFrameByIndex(i, vpX, vpY, vpGrideStrideX, vpGrideStrideY);
    }
  }

  #drawVideoFrameByIndex(index, x, y, w, h) {
    const commandEncoder = this.#device.createCommandEncoder();
    const textureView = this.#ctx.getCurrentTexture().createView();
    const renderPassDescriptor = {
      colorAttachments: [
        {
          view: textureView,
          clearValue: [1.0, 0.0, 0.0, 1.0],
          loadOp: "load",
          storeOp: "store",
        },
      ],
    };

    const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
    passEncoder.setPipeline(this.#pipeline);

    let uniformBindGroup = null;
    if (this.#sourceType == "VideoFrame" || this.#sourceType == "ColorChunk" || this.#sourceType == "Picture") {
      let frame = this.#workerFrameMap.get(index);
      if (!frame) return;

      uniformBindGroup = this.#device.createBindGroup({
        layout: this.#pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.#sampler },
          { binding: 1, resource: this.#device.importExternalTexture({ source: frame }) },
        ],
      });
    }

    if (!uniformBindGroup) return;
    passEncoder.setBindGroup(0, uniformBindGroup);
    passEncoder.setViewport(x, y, w, h, 0, 1);
    passEncoder.draw(6, 1, 0, 0);
    passEncoder.end();
    this.#device.queue.submit([commandEncoder.finish()]);
  }

  #drawVideoFrame() {
    if (this.#submitTimes === 1) {
      this.#drawVideoFrameWithOneTimeSubmit();
    } else {
      this.#drawVideoFrameWithMultipleTimesSubmit();
    }
  }

  #drawPicture() {
    let numberOfStream = this.#viewport.streamsCounter;
    if (!this.#device) return;
    if (!this.#sourceType || this.#sourceType == "") return;
    if (numberOfStream != this.#workerFrameMap.size) return;

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

    let vpGrideStrideX = this.#viewport.viewportGridStrideRow;
    let vpGrideStrideY = this.#viewport.viewportGridStrideCol;
    let colRow = this.#viewport.colRow;

    for (let i = 0; i < numberOfStream; ++i) {
      let uniformBindGroup = null;
      if (this.#sourceType == "VideoFrame" || this.#sourceType == "ColorChunk" || this.#sourceType == "Picture") {
        let frame = this.#workerFrameMap.get(i);
        if (!frame) continue;

        uniformBindGroup = this.#device.createBindGroup({
          layout: this.#pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: this.#sampler },
            { binding: 1, resource: this.#device.importExternalTexture({ source: frame }) },
          ],
        });
      }

      if (!uniformBindGroup) continue;
      passEncoder.setBindGroup(0, uniformBindGroup);
      const vpX = vpGrideStrideX * (i % colRow);
      const vpY = vpGrideStrideY * Math.floor(i / colRow);
      passEncoder.setViewport(vpX, vpY, vpGrideStrideX, vpGrideStrideY, 0, 1);
      passEncoder.draw(6, 1, 0, i);
    }
    passEncoder.end();
    this.#device.queue.submit([commandEncoder.finish()]);
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

  #updateYUVPlanesTexturesWith(workerId, textureAction, w = 0, h = 0, buffers = null, commandEncoder = null, cachedGPUTextureGroup = null) {
    if (textureAction === TEX_ACTION_WRITE_TEXTURE) {
      return this.#createYUVPlanesTexturesByWriteTexture(w, h, buffers);
    } else if (textureAction === TEX_ACTION_COPY_BUF_TO_TEX) {
      return this.#createYUVPlanesTexturesByCopyBufToTex(workerId, w, h, buffers, commandEncoder, cachedGPUTextureGroup);
    } else {
      console.warn(`${textureAction} is not supported yet!`);
      return null;
    }
  }

  #createYUVPlanesTexturesByWriteTexture(width, height, buffers) {
    let textures = {};
    const yTexture = this.#device.createTexture({
      size: { width: width, height: height },
      format: "r8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    // 写入 Y 通道数据
    this.#device.queue.writeTexture(
      { aspect: "all", texture: yTexture },
      buffers.yPlane,
      { bytesPerRow: width },
      { width: width, height: height },
    );

    textures.yTex = yTexture;

    // 创建 U 通道的纹理
    const uTexture = this.#device.createTexture({
      size: { width: width / 2, height: height / 2 }, // U 通道分辨率通常为 Y 的 1/2
      format: "r8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    // 写入 U 通道数据
    this.#device.queue.writeTexture(
      { aspect: "all", texture: uTexture },
      buffers.uPlane,
      { offset: 0, bytesPerRow: width / 2 },
      { width: width / 2, height: height / 2 },
    );

    textures.uTex = uTexture;

    // 创建 V 通道的纹理
    const vTexture = this.#device.createTexture({
      size: { width: width / 2, height: height / 2 }, // V 通道分辨率通常为 Y 的 1/2
      format: "r8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    // 写入 V 通道数据
    this.#device.queue.writeTexture(
      { aspect: "all", texture: vTexture },
      buffers.vPlane,
      { bytesPerRow: width / 2 },
      { width: width / 2, height: height / 2 },
    );

    textures.vTex = vTexture;
    return textures;
  }

  #createYUVPlanesTexturesByCopyBufToTex(workerId, width, height, srcBuffers, commandEncoder, cachedGPUTextureGroup = null) {
    if (!this.#bufferManager) {
      console.warn('buffer manager is not ready!');
      return;
    }

    if (!this.#device) {
      console.warn('GPUDevice is not ready!');
      return;
    }

    if (!commandEncoder) {
      console.warn('CommandEncoder is invalid!');
      return;
    }

    if (srcBuffers === undefined || srcBuffers == null) {
      console.warn('srcBuffers is invalid!');
      return;
    }

    // this.#device.pushErrorScope('validation');

    const yPlaneBytesPerRow = this.#align(Uint8Array.BYTES_PER_ELEMENT * width, 256);
    const uvPlaneBytesPerRow = this.#align(Uint8Array.BYTES_PER_ELEMENT * width / 2, 256);
    const usage = GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC;

    // use cached textures or create textures
    let yPlaneTex = null;
    let uPlaneTex = null;
    let vPlaneTex = null;
    if (cachedGPUTextureGroup) {
      yPlaneTex = cachedGPUTextureGroup.yTex;
      uPlaneTex = cachedGPUTextureGroup.uTex;
      vPlaneTex = cachedGPUTextureGroup.vTex;
    } else {
      const texUsage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC;
      
      /* create new GPUTexture */
      yPlaneTex = this.#device.createTexture({
        size: { width: width, height: height },
        format: "r8unorm",
        usage: texUsage,
      });

      uPlaneTex = this.#device.createTexture({
        size: { width: width / 2, height: height / 2 },
        format: "r8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
      });

      vPlaneTex = this.#device.createTexture({
        size: { width: width / 2, height: height / 2 },
        format: "r8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
      });
    }

    // acquire GPUBuffers from BufferManager and map src buffers to GPUBuffers
    const yPlaneStagingBuffer = this.#bufferManager.acquireBuffer(`${workerId}_Y`, usage, yPlaneBytesPerRow * height, true, false);
    const uPlaneStagingBuffer = this.#bufferManager.acquireBuffer(`${workerId}_U`, usage, uvPlaneBytesPerRow * height / 2, true, false);
    const vPlaneStagingBuffer = this.#bufferManager.acquireBuffer(`${workerId}_V`, usage, uvPlaneBytesPerRow * height / 2, true, false);

    const yPlaneMappedArray = new Uint8Array(yPlaneStagingBuffer.getMappedRange());
    const uPlaneMappedArray = new Uint8Array(uPlaneStagingBuffer.getMappedRange());
    const vPlaneMappedArray = new Uint8Array(vPlaneStagingBuffer.getMappedRange());
    const yStride = width * Uint8Array.BYTES_PER_ELEMENT;
    const uvStride = yStride / 2;

    for (let i = 0; i < height; ++i) {
      yPlaneMappedArray.set(new Uint8Array(srcBuffers.yPlane, i * yStride, yStride), i * yPlaneBytesPerRow);
      if (i < height / 2) {
        uPlaneMappedArray.set(new Uint8Array(srcBuffers.uPlane, i * uvStride, uvStride), i * uvPlaneBytesPerRow);
        vPlaneMappedArray.set(new Uint8Array(srcBuffers.vPlane, i * uvStride, uvStride), i * uvPlaneBytesPerRow);
      }
    }

    yPlaneStagingBuffer.unmap();
    uPlaneStagingBuffer.unmap();
    vPlaneStagingBuffer.unmap();

    // next, copy all buffers to textures
    commandEncoder.copyBufferToTexture(
      {
        // source
        buffer: yPlaneStagingBuffer,
        offset: 0,
        bytesPerRow: yPlaneBytesPerRow,
        rowsPerImage: height
      },
      {
        // dest
        texture: yPlaneTex
      },
      [width, height, 1]
    );

    commandEncoder.copyBufferToTexture(
      {
        // source
        buffer: uPlaneStagingBuffer,
        offset: 0,
        bytesPerRow: uvPlaneBytesPerRow,
        rowsPerImage: height / 2
      },
      {
        // dest
        texture: uPlaneTex
      },
      [width / 2, height / 2, 1]
    );

    commandEncoder.copyBufferToTexture(
      {
        // source
        buffer: vPlaneStagingBuffer,
        offset: 0,
        bytesPerRow: uvPlaneBytesPerRow,
        rowsPerImage: height / 2
      },
      {
        // dest
        texture: vPlaneTex
      },
      [width / 2, height / 2, 1]
    );

    // commandEncoder.clearBuffer(yPlaneStagingBuffer);
    // commandEncoder.clearBuffer(uPlaneStagingBuffer);
    // commandEncoder.clearBuffer(vPlaneStagingBuffer);

    // this.#device.queue.submit([commandEncoder.finish()]);

    // TODO: this code can output the logs or data from shaders
    // const uvPlaneBufOutputStagingBuffer = this.#device.createBuffer({
    //   size: uvPlaneBytesPerRow * height / 2,
    //   usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    // });

    // const uvPlaneTexOutputStagingBuffer = this.#device.createBuffer({
    //   size: uvPlaneBytesPerRow * height / 2,
    //   usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    // });

    // commandEncoder.copyBufferToBuffer(
    //   uPlaneStagingBuffer, 0,
    //   uvPlaneBufOutputStagingBuffer, 0,
    //   uvPlaneBytesPerRow * height / 2
    // );

    // commandEncoder.copyTextureToBuffer(
    //   {
    //     texture: uPlaneTex,
    //   },
    //   {
    //     buffer: uvPlaneTexOutputStagingBuffer,
    //     bytesPerRow: uvPlaneBytesPerRow
    //   },
    //   {
    //     width: width / 2,
    //     height: height / 2,
    //     depthOrArrayLayers: 1
    //   }
    // );

    // this.#device.queue.submit([commandEncoder.finish()]);

    // uvPlaneBufOutputStagingBuffer.mapAsync(GPUMapMode.READ, 0, uvPlaneBytesPerRow * height / 2).then((buffer) => {
    //   // console.log(`yPlaneBuffer is ${buffer}`);
    //   const copyArrayBuffer = uvPlaneBufOutputStagingBuffer.getMappedRange(0, uvPlaneBytesPerRow * height / 2);
    //   const data = copyArrayBuffer.slice();
    //   yPlaneStagingBuffer.unmap();
    //   // console.log(`yPlaneBuffer is ${new Uint8Array(data)}`);
    //   console.log(`yPlaneBuf is ${new Uint8Array(data)}`);
    // });
    
    // uvPlaneTexOutputStagingBuffer.mapAsync(GPUMapMode.READ, 0, uvPlaneBytesPerRow * height / 2).then((buffer) => {
    //   // console.log(`yPlaneBuffer is ${buffer}`);
    //   const copyArrayBuffer = uvPlaneTexOutputStagingBuffer.getMappedRange(0, uvPlaneBytesPerRow * height / 2);
    //   const data = copyArrayBuffer.slice();
    //   yPlaneStagingBuffer.unmap();
    //   // console.log(`yPlaneBuffer is ${new Uint8Array(data)}`);
    //   console.log(`yPlaneTexture is ${new Uint8Array(data)}`);
    // });

    // this.#device.popErrorScope().then((error) => {
    //   if (error) {
    //     console.error(`An error occured while mapping: ${error.message}`);
    //   }
    // });

    let textures = {};
    textures.yTex = yPlaneTex;
    textures.uTex = uPlaneTex;
    textures.vTex = vPlaneTex;
    return textures;
  }

  #align(n, alignment) {
    return Math.ceil(n / alignment) * alignment;
  }

  #acquireGlobalCommandEncoder() {
    if (!this.#device) {
      console.error('GPUDevice is not ready! No avaliable command encoder.');
      return null;
    }

    if (!this.#globalCommandEncoder) {
      this.#globalCommandEncoder = this.#device.createCommandEncoder();
    }

    return this.#globalCommandEncoder;
  }

  #submit() {
    if (this.#globalCommandEncoder) {
      this.#device.queue.submit([this.#globalCommandEncoder.finish()]);
    }

    this.#globalCommandEncoder = null;
  }
};