'use strict';

import WorkerMgr from "./WorkerMgr.js";

let preferredResolution;
let mediaStream, bitrate = 100000;
let stopped = false;
let preferredCodec = "VP8";
let mode = "L1T3";
let latencyPref = "realtime", bitPref = "variable";
let hw = "no-preference";
let renderType = "WebGPU";
let sourceType = "VideoFrame";
let streamWorker;
let workerMgr;
let inputStream, outputStream;
let videoSource;
let streamsCounter = 1;
let submitTimes = 1;
let textureActionType = 1;

const rate = document.querySelector('#rate');
const connectButton = document.querySelector('#connect');
const stopButton = document.querySelector('#stop');
const getAIButton = document.querySelector('#getAdapterInfo');
const codecButtons = document.querySelector('#codecButtons');
const resButtons = document.querySelector('#resButtons');
const modeButtons = document.querySelector('#modeButtons');
const hwButtons = document.querySelector('#hwButtons');
const renderTypeButtons = document.querySelector('#renderTypeButtons');
const sourceTypeButtons = document.querySelector('#renderSourceButtons');
const videoSelect = document.querySelector('select#videoSource');
const offscreen = document.querySelector("canvas").transferControlToOffscreen();
const streamsCounterInput = document.getElementById('numberOfStreamsId');
const submitTimeOptions = document.querySelector('#renderCmdSubmitOptions');
const textureActionOptions = document.querySelector('#textureActionOptions');
const selectors = [videoSelect];
const wmCheckBox = document.getElementById("wmCheckbox");

wmCheckBox.checked = false;
connectButton.disabled = false;
stopButton.disabled = true;

const qvgaConstraints = { video: { width: 320, height: 240 } };
const vgaConstraints = { video: { width: 640, height: 480 } };
const hdConstraints = { video: { width: 1280, height: 720 } };
// const fullHdConstraints = {video: {width: {min: 1920}, height: {min: 1080}}};
const fullHdConstraints = { video: { width: { min: 1280 }, height: { min: 720 } } };
const tv4KConstraints = { video: { width: { exact: 3840 }, height: { exact: 2160 } } };
const cinema4KConstraints = { video: { width: { exact: 4096 }, height: { exact: 2160 } } };
const eightKConstraints = { video: { width: { min: 7680 }, height: { min: 4320 } } };

let constraints = qvgaConstraints;

function addToEventLog(text, severity = 'info') {
  let log = document.querySelector('textarea');
  log.value += 'log-' + severity + ': ' + text + '\n';
  if (severity == 'fatal') stop();
}

function gotDevices(deviceInfos) {
  // Handles being called several times to update labels. Preserve values.
  const values = selectors.map(select => select.value);
  selectors.forEach(select => {
    while (select.firstChild) {
      select.removeChild(select.firstChild);
    }
  });
  for (let i = 0; i !== deviceInfos.length; ++i) {
    const deviceInfo = deviceInfos[i];
    const option = document.createElement('option');
    option.value = deviceInfo.deviceId;
    if (deviceInfo.kind === 'videoinput') {
      option.text = deviceInfo.label || `camera ${videoSelect.length + 1}`;
      videoSelect.appendChild(option);
    }
  }
  selectors.forEach((select, selectorIndex) => {
    if (Array.prototype.slice.call(select.childNodes).some(n => n.value === values[selectorIndex])) {
      select.value = values[selectorIndex];
    }
  });
}

async function getResValue(radioValue) {
  preferredResolution = radioValue;
  addToEventLog('Resolution selected: ' + preferredResolution);
  switch (preferredResolution) {
    case "qvga":
      constraints = qvgaConstraints;
      break;
    case "vga":
      constraints = vgaConstraints;
      break;
    case "hd":
      constraints = hdConstraints;
      break;
    case "full-hd":
      constraints = fullHdConstraints;
      break;
    case "tv4K":
      constraints = tv4KConstraints;
      break;
    case "cinema4K":
      constraints = cinema4KConstraints;
      break;
    case "eightK":
      constraints = eightKConstraints;
      break;
    default:
      constraints = qvgaConstraints;
      break;
  }
  // Get a MediaStream from the webcam, and reset the resolution.
  try {
    //stop the tracks
    if (mediaStream) {
      mediaStream.getTracks().forEach(track => {
        track.stop();
      });
    }
    gotDevices(await navigator.mediaDevices.enumerateDevices());
    constraints.deviceId = videoSource ? { exact: videoSource } : undefined;
    mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    document.getElementById('inputVideo').srcObject = mediaStream;
  } catch (e) {
    addToEventLog(`EnumerateDevices or gUM error: ${e.message}`);
  }
}

export function getPrefValue(radio) {
  latencyPref = radio.value;
  addToEventLog('Latency preference selected: ' + latencyPref);
}

export function getBitPrefValue(radio) {
  bitPref = radio.value;
  addToEventLog('Bitrate mode selected: ' + bitPref);
}

export function getCodecValue(radio) {
  preferredCodec = radio.value;
  addToEventLog('Codec selected: ' + preferredCodec);
}

export function getModeValue(radio) {
  mode = radio.value;
  addToEventLog('Mode selected: ' + mode);
}

export function getHwValue(radio) {
  hw = radio.value;
  addToEventLog('Hardware Acceleration preference: ' + hw);
}

export function getRenderTypeValue(radio) {
  renderType = radio.value;
  addToEventLog('Render type: ' + renderType);
}

export function getSourceTypeValue(radio) {
  sourceType = radio.value;
  if (sourceType == "Picture" || sourceType == "ColorChunk") {
    constraints = qvgaConstraints
  }

  addToEventLog('Source type: ' + sourceType);
}

export function getSubmitTimeOptionsValue(radio) {
  submitTimes = parseInt(radio.value);
  let text = submitTimes == 1 ? 'one time' : 'multiple times';
  addToEventLog('times of submitting render commands: ' + text);
}

export function getTextureActionOptionsValue(radio) {
  textureActionType = parseInt(radio.value);
  let text = textureActionType == 1 ? 'writeTexture(...)' : 'copyBufferToTexture(...)';
  addToEventLog('action of uploading content to a texture: ' + text);
}

function stop() {
  stopped = true;
  stopButton.disabled = true;
  connectButton.disabled = true;
  // streamWorker.postMessage({ type: "stop" });

  if (workerMgr) {
    workerMgr.workersStop();
  }

  const date = new Date();
  const dateStr = `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
  addToEventLog(`Rendering stops at ${dateStr}`);

  try {
    inputStream.cancel();
    addToEventLog('inputStream cancelled');
  } catch (e) {
    addToEventLog(`Could not cancel inputStream: ${e.message}`);
  }
  try {
    outputStream.abort();
    addToEventLog('outputStream aborted');
  } catch (e) {
    addToEventLog(`Could not abort outputStream: ${e.message}`);
  }
}

document.addEventListener('DOMContentLoaded', async function (event) {
  if (stopped) return;
  addToEventLog('DOM Content Loaded');

  if (typeof MediaStreamTrackProcessor === 'undefined' ||
    typeof MediaStreamTrackGenerator === 'undefined') {
    addToEventLog('Your browser does not support the experimental Mediacapture-transform API.\n' +
      'Please launch with the --enable-blink-features=WebCodecs,MediaStreamInsertableStreams flag', 'fatal');
    return;
  }
  try {
    gotDevices(await navigator.mediaDevices.enumerateDevices());
  } catch (e) {
    addToEventLog('Error in Device enumeration');
  }
  constraints.deviceId = videoSource ? { exact: videoSource } : undefined;
  // Get a MediaStream from the webcam.
  mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
  // Connect the webcam stream to the video element.
  document.getElementById('inputVideo').srcObject = mediaStream;
  // Create a new worker.
  // streamWorker = new Worker("js/StreamWorker.js");
  addToEventLog('Worker created.');
  // Print messages from the worker in the text area.
  // streamWorker.addEventListener('message', function(e) {
  //   addToEventLog('Worker msg: ' + e.data.text, e.data.severity);
  // }, false);

  stopButton.onclick = () => {
    addToEventLog('Stop button clicked.');
    stop();
  }

  getAIButton.onclick = async () => {
    const adapterInfo = await getAdapterInfo();
    addToEventLog(`arch:${adapterInfo.architecture} desc:${adapterInfo.description} dvc:${adapterInfo.device} vendor:${adapterInfo.vendor}`);
  }

  async function getAdapterInfo() {
    if (!navigator.gpu) {
      return 'WebGPU is not supported!';
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      return 'Cannot request an adapter!';
    }

    const adapterInfo = await adapter.requestAdapterInfo();
    return `${adapterInfo}`;
  }

  // Add event listener to each radio button
  const radioButtons = document.querySelectorAll('input[name="resolution"]');
  radioButtons.forEach((radio) => {
    radio.addEventListener('change', () => {
      // Get the value of the selected radio button
      const selectedValue = document.querySelector('input[name="resolution"]:checked').value;
      getResValue(selectedValue);
      // Log the selected value
      console.log(selectedValue);
    });
  });

  const stBtns = document.querySelectorAll('input[name="SourceType"]');
  stBtns.forEach((radio) => {
    radio.addEventListener('change', () => {
      // Get the value of the selected radio button
      const selectedValue = document.querySelector('input[name="SourceType"]:checked').value;
      if (selectedValue != "VideoFrame") {
        document.getElementById('inputVideo').style.display = "none";
      } else {
        document.getElementById('inputVideo').style.display = "block";
      }
      // Log the selected value
      console.log(selectedValue);
    });
  });

  connectButton.onclick = () => {
    connectButton.disabled = true;
    stopButton.disabled = false;
    hwButtons.style.display = "none";
    renderTypeButtons.style.display = "none";
    sourceTypeButtons.style.display = "none";
    prefButtons.style.display = "none";
    bitButtons.style.display = "none";
    codecButtons.style.display = "none";
    resButtons.style.display = "none";
    modeButtons.style.display = "none";
    rateInput.style.display = "none";
    keyInput.style.display = "none";
    submitTimeOptions.style.display = "none";
    textureActionOptions.style.display = "none";
    startMedia();
  }

  async function startMedia() {
    if (stopped) return;
    addToEventLog('startMedia called');
    
    // record date to log zone
    const date = new Date();
    const dateStr = `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
    addToEventLog(`Rendering starts from ${dateStr}`);

    try {
      // Collect the bitrate
      const rate = document.getElementById('rate').value;

      // Collect the keyframe gap
      const keygap = document.getElementById('keygap').value;

      const codecCheckedRadio = codecButtons.querySelector('input[type="radio"]:checked');
      getCodecValue(codecCheckedRadio);

      const hwCheckedRadio = hwButtons.querySelector('input[type="radio"]:checked');
      getHwValue(hwCheckedRadio);

      const rtCheckedRadio = renderTypeButtons.querySelector('input[type="radio"]:checked');
      getRenderTypeValue(rtCheckedRadio);

      const stCheckedRadio = sourceTypeButtons.querySelector('input[type="radio"]:checked');
      getSourceTypeValue(stCheckedRadio);

      const submitTimesCheckedRadio = submitTimeOptions.querySelector('input[type="radio"]:checked');
      getSubmitTimeOptionsValue(submitTimesCheckedRadio);

      const textureActionCheckedRadio = textureActionOptions.querySelector('input[type="radio"]:checked');
      getTextureActionOptionsValue(textureActionCheckedRadio);

      if (sourceType == "VideoFrame") {
        // Create a MediaStreamTrackProcessor, which exposes frames from the track
        // as a ReadableStream of VideoFrames, using non-standard Chrome API.
        let [track] = mediaStream.getVideoTracks();
        let ts = track.getSettings();
        const processor = new MediaStreamTrackProcessor(track);
        inputStream = processor.readable;

        // Create a MediaStreamTrackGenerator, which exposes a track from a
        // WritableStream of VideoFrames, using non-standard Chrome API.
        const generator = new MediaStreamTrackGenerator({ kind: 'video' });
        outputStream = generator.writable;
        document.getElementById('outputVideo').srcObject = new MediaStream([generator]);

        //Create video Encoder configuration
        const vConfig = {
          keyInterval: keygap,
          resolutionScale: 1,
          framerateScale: 1.0,
        };

        let ssrcArr = new Uint32Array(1);
        window.crypto.getRandomValues(ssrcArr);
        const ssrc = ssrcArr[0];
        const isMultipleTextures = wmCheckBox.checked;

        const config = {
          alpha: "discard",
          latencyMode: latencyPref,
          bitrateMode: bitPref,
          codec: preferredCodec,
          width: ts.width / vConfig.resolutionScale,
          height: ts.height / vConfig.resolutionScale,
          hardwareAcceleration: hw,
          bitrate: rate,
          framerate: ts.frameRate / vConfig.framerateScale,
          keyInterval: vConfig.keyInterval,
          ssrc: ssrc,
          isMultipleTextures: isMultipleTextures,
          renderType: renderType,
          sourceType: sourceType,
          submitTimes: submitTimes,
          textureAction: textureActionType,
        };

        // const config = {
        //   codec: 'av01.1.04M.08',
        //   width: 1920, // 设置视频宽度
        //   height: 1080, // 设置视频高度
        //   framerate: 30, // 设置帧率（每秒帧数）
        //   bitrate: 5000000, // 设置视频比特率（bps，此处为5 Mbps）
        // };

        if (mode != "L1T1") {
          config.scalabilityMode = mode;
        }

        switch (preferredCodec) {
          case "H264":
            config.codec = "avc1.42002A";  // baseline profile, level 4.2
            config.avc = { format: "annexb" };
            config.pt = 1;
            break;
          case "H265":
            config.codec = "hvc1.1.6.L123.00"; // Main profile, level 4.1, main Tier
            config.hevc = { format: "annexb" };
            config.pt = 2;
            break;
          case "VP8":
            config.codec = "vp8";
            config.pt = 3;
            break;
          case "VP9":
            config.codec = "vp09.00.10.08"; //VP9, Profile 0, level 1, bit depth 8
            config.pt = 4;
            break;
          case "AV1":
            config.codec = "av01.0.08M.10.0.110.09" // AV1 Main Profile, level 4.0, Main tier, 10-bit content, non-monochrome, with 4:2:0 chroma subsampling
            config.pt = 5;
            break;
        }

        // query input of streamsCounter for evaluating layout
        streamsCounter = Number(streamsCounterInput.value);
        let viewport = {
          streamsCounter: streamsCounter,
          constraints: constraints,
        };

        workerMgr = new WorkerMgr(streamsCounter);
        const startInfo = {
          cmd: "start",
          config: config,
          offscreen: offscreen,
          viewport: viewport,
          streams: { input: inputStream, output: outputStream },
        };
        workerMgr.workersStart(startInfo);
      } else {
        // query input of streamsCounter for evaluating layout
        streamsCounter = Number(streamsCounterInput.value);
        let viewport = {
          streamsCounter: streamsCounter,
          constraints: constraints,
        };

        const isMultipleTextures = wmCheckBox.checked;

        const config = {
          hardwareAcceleration: hw,
          isMultipleTextures: isMultipleTextures,
          renderType: renderType,
          sourceType: sourceType,
          submitTimes: submitTimes,
          textureAction: textureActionType,
        };

        workerMgr = new WorkerMgr(streamsCounter);
        const startInfo = {
          cmd: "start",
          config: config,
          offscreen: offscreen,
          viewport: viewport,
        };
        workerMgr.workersStart(startInfo);
      }

      document.getElementById('inputVideo').style.display = "none";
    } catch (e) {
      addToEventLog(e.name + ": " + e.message, 'fatal');
    }
  }
}, false);
