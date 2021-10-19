// check for support of insertable streams
if (typeof MediaStreamTrackProcessor === 'undefined' ||
    typeof MediaStreamTrackGenerator === 'undefined') {
    alert("insertable streams non supported");
}

try {
    new MediaStreamTrackGenerator('audio');
    console.log("Audio insertable streams supported");
} catch (e) {
    alert("Your browser does not support insertable audio streams");
}

if (typeof AudioData === 'undefined') {
    alert("Your browser does not support WebCodecs.");
}

// Config variables: change them to point to your own servers
const SIGNALING_SERVER_URL = 'http://localhost:9999';
const TURN_SERVER_URL = 'localhost:3478';
const TURN_SERVER_USERNAME = 'username';
const TURN_SERVER_CREDENTIAL = 'credential';
// WebRTC config: you don't have to change this for the example to work
// If you are testing on localhost, you can just use PC_CONFIG = {}
const PC_CONFIG = {
  iceServers: [
    {
      urls: 'turn:' + TURN_SERVER_URL + '?transport=tcp',
      username: TURN_SERVER_USERNAME,
      credential: TURN_SERVER_CREDENTIAL
    },
    {
      urls: 'turn:' + TURN_SERVER_URL + '?transport=udp',
      username: TURN_SERVER_USERNAME,
      credential: TURN_SERVER_CREDENTIAL
    }
  ]
};

// enable/disable these tests to see insertable-streams in action
let insertOutboundTonePulse = false; // this works
let insertInboundTonePulse = true; // this doesn't work (why not?)

// insertable-streams stuff
let processor;
let transformer;
let generator;

function getPulseToneTransform() {
  // getPulseToneTransform() returns function for adding a pulsing tone to audio stream
  const format = 'f32-planar';
  const frequencyA = 120.0;
  const frequencyB = 0.75;
  const omegaA = 2.0 * Math.PI * frequencyA;
  const omegaB = 2.0 * Math.PI * frequencyB;
  let phaseA = 0.0;
  let phaseB = 0.0;
  let two_pi = 2.0 * Math.PI;
  let buffer_size = 2 * 2048; // twice the expected necessary size
  const buffer = new Float32Array(buffer_size);

  return (data, controller) => {
    const dt = 1.0 / data.sampleRate;
    const nChannels = data.numberOfChannels;

    for (let c = 0; c < nChannels; c++) {
      const offset = data.numberOfFrames * c;
      // 'samples' is floating point PCM data in range [-1, 1]
      const samples = buffer.subarray(offset, offset + data.numberOfFrames);
      data.copyTo(samples, {planeIndex: c, format});

      // Add warbled tone
      for (let i = 0; i < samples.length; ++i) {
        let t = i * dt;
        let b = Math.sin(phaseB + omegaB * t);
        samples[i] = Math.min(Math.max(-1.0, samples[i] + 0.5 * Math.sin(phaseA + omegaA * t) * b*b), 1.0);
      }
    }                                                                                                                                                           
    phaseA += omegaA * data.numberOfFrames * dt;
    if (phaseA > two_pi) {
      phaseA -= two_pi;
    }
    phaseB += omegaB * data.numberOfFrames * dt;
    if (phaseB > two_pi) {
      phaseB -= two_pi;
    }
    controller.enqueue(new AudioData({
      format,
      sampleRate: data.sampleRate,
      numberOfFrames: data.numberOfFrames,
      numberOfChannels: nChannels,
      timestamp: data.timestamp,
      data: buffer
    }));
  };
}


// Signaling methods
let socket = io(SIGNALING_SERVER_URL, { autoConnect: false });

socket.on('data', (data) => {
  console.log('Data received: ',data);
  handleSignalingData(data);
});

socket.on('ready', () => {
  console.log('Ready');
  // Connection with signaling server is ready, and so is local stream
  createPeerConnection();
  sendOffer();
});

let sendData = (data) => {
  socket.emit('data', data);
};

// WebRTC methods
let pc;
let localStream;
let remoteStreamElement = document.querySelector('#remoteStream');

let getLocalStream = () => {
  navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    .then((stream) => {
      console.log('Stream found');
      localStream = stream;
      // Connect after making sure that local stream is availble
      socket.connect();
    })
    .catch(error => {
      console.error('Stream not found: ', error);
    });
}

let createPeerConnection = () => {
  try {
    pc = new RTCPeerConnection(PC_CONFIG);
    pc.onicecandidate = onIceCandidate;
    pc.ontrack = onTrack;

    if (insertOutboundTonePulse) {
      // this works: add a pulsed tone to mic audio before sending to peer

      // create insertable-streams pipes and cog
      processor = new MediaStreamTrackProcessor(localStream.getAudioTracks()[0]);
      transformer = new TransformStream({transform: getPulseToneTransform()});
      generator = new MediaStreamTrackGenerator('audio');

      // create an abortController for cleanup
      let abortController = new AbortController();
      const signal = abortController.signal;

      // this is where we connect the insertable-stream pipes
      const source = processor.readable;
      const sink = generator.writable;
      const promise = source.pipeThrough(transformer, {signal}).pipeTo(sink);
      promise.catch((e) => {
        if (signal.aborted) {
          console.log('Shutting down streams after abort.');
        } else {
          console.error('Error from stream transform:', e);
        }
        source.cancel(e);
        sink.abort(e);
      });

      // connect final stream to PeerConnection
      let modifiedStream = new MediaStream();
      modifiedStream.addTrack(generator);
      pc.addStream(modifiedStream);
    } else {
      pc.addStream(localStream);
    }
    console.log('PeerConnection created');
  } catch (error) {
    console.error('PeerConnection failed: ', error);
  }
};

let sendOffer = () => {
  console.log('Send offer');
  pc.createOffer().then(
    setAndSendLocalDescription,
    (error) => { console.error('Send offer failed: ', error); }
  );
};

let sendAnswer = () => {
  console.log('Send answer');
  pc.createAnswer().then(
    setAndSendLocalDescription,
    (error) => { console.error('Send answer failed: ', error); }
  );
};

let setAndSendLocalDescription = (sessionDescription) => {
  pc.setLocalDescription(sessionDescription);
  console.log('Local description set');
  sendData(sessionDescription);
};

let onIceCandidate = (event) => {
  if (event.candidate) {
    console.log('ICE candidate');
    sendData({
      type: 'candidate',
      candidate: event.candidate
    });
  }
};

let onTrack = (event) => {
  console.log('Add track');
  if (insertInboundTonePulse) {
    // this does NOT work: add pulsed tone to received peer audio before playing
    // * no received audio plays at all
    // * the transform function returned by getPulseToneTransform() is never called
    // this appears to be a BUG

    // create insertable-streams pipes and cog
    processor = new MediaStreamTrackProcessor(event.track);
    transformer = new TransformStream({transform: getPulseToneTransform()});
    generator = new MediaStreamTrackGenerator('audio');

    // create an abortController for cleanup
    let abortController = new AbortController();
    const signal = abortController.signal;

    // this is where we connect the insertable-stream pipes
    const source = processor.readable;
    const sink = generator.writable;
    const promise = source.pipeThrough(transformer, {signal}).pipeTo(sink);
    promise.catch((e) => {
      if (signal.aborted) {
        console.log('Shutting down streams after abort.');
      } else {
        console.error('Error from stream transform:', e);
      }
      source.cancel(e);
      sink.abort(e);
    });

    // connect final stream to PeerConnection
    let modifiedStream = new MediaStream();
    modifiedStream.addTrack(generator);
    remoteStreamElement.srcObject = modifiedStream;
  } else {
    remoteStreamElement.srcObject = event.streams[0];
  }
};

let handleSignalingData = (data) => {
  switch (data.type) {
    case 'offer':
      createPeerConnection();
      pc.setRemoteDescription(new RTCSessionDescription(data));
      sendAnswer();
      break;
    case 'answer':
      pc.setRemoteDescription(new RTCSessionDescription(data));
      break;
    case 'candidate':
      pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      break;
  }
};

// Start connection
getLocalStream();
