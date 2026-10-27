const elements = {
    fileInput: document.getElementById('video-file'),
    fileName: document.getElementById('video-file-name'),
    video: document.getElementById('analysis-video'),
    overlay: document.getElementById('detection-overlay'),
    videoError: document.getElementById('video-error-message'),
    playButton: document.getElementById('video-play-btn'),
    speedButton: document.getElementById('video-speed-btn'),
    analyzeButton: document.getElementById('analyze-btn'),
    stopAnalysisButton: document.getElementById('stop-analysis-btn'),
    analysisStatus: document.getElementById('analysis-status'),
    peopleCount: document.getElementById('people-count'),
    animalCount: document.getElementById('animal-count'),
    detectionSummary: document.getElementById('detection-summary'),
    inferenceTime: document.getElementById('inference-time'),
    framesAnalyzed: document.getElementById('frames-analyzed'),
    confidenceThreshold: document.getElementById('confidence-threshold'),
    confidenceValue: document.getElementById('confidence-value'),
    timeline: document.getElementById('video-timeline'),
    timelineMarkers: document.getElementById('detection-markers'),
    timestamp: document.getElementById('video-timestamp'),
    connectButton: document.getElementById('webrtc-connect-btn'),
    disconnectButton: document.getElementById('webrtc-disconnect-btn'),
    remoteVideo: document.getElementById('webrtc-video'),
    connectionState: document.getElementById('connection-state'),
    iceState: document.getElementById('ice-state'),
    codec: document.getElementById('codec-value'),
    roundTripTime: document.getElementById('rtt-value'),
    bitrate: document.getElementById('bitrate-value'),
    candidateCount: document.getElementById('candidate-count'),
    webrtcStatus: document.getElementById('webrtc-status'),
    webrtcLog: document.getElementById('webrtc-log')
};

const missingElements = Object.entries(elements)
    .filter(([, element]) => !element)
    .map(([name]) => name);

if (missingElements.length) {
    throw new Error(`Video lab is missing required elements: ${missingElements.join(', ')}`);
}

const animalLabels = new Set([
    'bird', 'cat', 'dog', 'horse', 'sheep', 'cow',
    'elephant', 'bear', 'zebra', 'giraffe'
]);

let videoObjectUrl = null;
let playbackSpeedIndex = 0;
const playbackSpeeds = [1, 2, 3];
const playbackState = {
    isPlaying: false,
    isPaused: true,
    currentTime: 0,
    currentSpeed: playbackSpeeds[playbackSpeedIndex]
};
const frameSampleInterval = 0.6;
let detectorPromise = null;
let detector = null;
let analysisActive = false;
let analysisCompletedForVideo = false;
let analysisTimer = null;
let inferenceInProgress = false;
let analysisRun = 0;
const analyzedFrameKeys = new Set();
const analyzedFrameDetails = new Map();
const detectionMarkers = new Map();
let peerConnection = null;
let remotePeerConnection = null;
let capturedStream = null;
let statsTimer = null;
let previousBytesSent = null;
let previousStatsTime = null;

function setStatus(element, message, isError = false) {
    element.textContent = message;
    element.classList.toggle('text-red-300', isError);
    element.classList.toggle('text-gray-400', !isError);
}

function updatePlayButton() {
    playbackState.isPlaying = !elements.video.paused && !elements.video.ended;
    playbackState.isPaused = elements.video.paused || elements.video.ended;
    elements.playButton.textContent = playbackState.isPlaying ? 'Pause' : 'Play';
    elements.playButton.setAttribute('aria-label', playbackState.isPlaying ? 'Pause video' : 'Play video');
}

function showVideoError(message) {
    elements.videoError.textContent = message;
    elements.videoError.classList.remove('hidden');
    elements.videoError.classList.add('flex');
    elements.playButton.disabled = true;
    elements.speedButton.disabled = true;
    elements.analyzeButton.disabled = true;
    elements.connectButton.disabled = true;
    elements.timeline.disabled = true;
    setStatus(elements.analysisStatus, message, true);
}

function clearVideoError() {
    elements.videoError.textContent = '';
    elements.videoError.classList.add('hidden');
    elements.videoError.classList.remove('flex');
}

function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return '00:00';
    const total = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const remainder = total % 60;
    const clock = [hours, minutes, remainder]
        .map((part) => String(part).padStart(2, '0'));
    return hours ? clock.join(':') : clock.slice(1).join(':');
}

function updateTimeline() {
    playbackState.currentTime = elements.video.currentTime || 0;
    const duration = Number.isFinite(elements.video.duration)
        ? elements.video.duration
        : 0;
    elements.timeline.max = String(duration);
    elements.timeline.value = String(elements.video.currentTime || 0);
    elements.timestamp.textContent =
        `${formatTime(elements.video.currentTime)} / ${formatTime(duration)}`;
}

function clearDetectionState() {
    analysisCompletedForVideo = false;
    analyzedFrameKeys.clear();
    analyzedFrameDetails.clear();
    detectionMarkers.clear();
    elements.timelineMarkers.replaceChildren();
    elements.peopleCount.textContent = '—';
    elements.animalCount.textContent = '—';
    elements.inferenceTime.textContent = '—';
    elements.framesAnalyzed.textContent = '0';
    elements.detectionSummary.textContent =
        'Start analysis to inspect sampled frames.';
    const context = elements.overlay.getContext('2d');
    context.clearRect(0, 0, elements.overlay.width, elements.overlay.height);
}

function stopAnalysis(message = 'Analysis stopped.') {
    analysisRun += 1;
    analysisActive = false;
    inferenceInProgress = false;
    window.clearInterval(analysisTimer);
    analysisTimer = null;
    elements.analyzeButton.disabled = !elements.video.currentSrc;
    elements.stopAnalysisButton.disabled = true;
    setStatus(elements.analysisStatus, message);
}

function storeFrameDetails(time, people, animals) {
    if (!Number.isFinite(elements.video.duration)) return;
    const frameKey = Math.floor(time / frameSampleInterval);
    analyzedFrameKeys.add(frameKey);
    analyzedFrameDetails.set(frameKey, { time, people, animals });
    elements.framesAnalyzed.textContent = String(analyzedFrameKeys.size);

    let marker = detectionMarkers.get(frameKey);
    if (people + animals === 0) {
        marker?.remove();
        detectionMarkers.delete(frameKey);
        return;
    }

    if (!marker) {
        marker = document.createElement('span');
        marker.className = 'absolute top-0 h-2 w-1 -translate-x-1/2 rounded bg-amber-400';
        detectionMarkers.set(frameKey, marker);
        elements.timelineMarkers.append(marker);
    }
    const percentage = Math.min(100, Math.max(0, time / elements.video.duration * 100));
    marker.style.left = `${percentage}%`;
    marker.title = `${formatTime(time)}: ${people} people, ${animals} animals`;
}

function drawDetections(predictions) {
    const canvas = elements.overlay;
    const video = elements.video;
    if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
    }

    const context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.lineWidth = Math.max(2, canvas.width / 400);
    context.font = `${Math.max(14, canvas.width / 45)}px sans-serif`;

    predictions.forEach((prediction) => {
        if (prediction.class !== 'person' && !animalLabels.has(prediction.class)) return;
        const [x, y, width, height] = prediction.bbox;
        const color = prediction.score < 0.2
            ? '#fbbf24'
            : prediction.class === 'person' ? '#34d399' : '#60a5fa';
        const label = `${prediction.class} ${Math.round(prediction.score * 100)}%`;
        context.strokeStyle = color;
        context.fillStyle = color;
        context.strokeRect(x, y, width, height);
        const labelY = Math.max(context.measureText(label).actualBoundingBoxAscent + 8, y);
        context.fillRect(x, labelY - context.measureText(label).actualBoundingBoxAscent - 8,
            context.measureText(label).width + 12,
            context.measureText(label).actualBoundingBoxAscent + 12);
        context.fillStyle = '#07111f';
        context.fillText(label, x + 6, labelY);
    });
}

async function loadDetector() {
    if (detector) return detector;
    if (!window.cocoSsd || !window.tf) {
        throw new Error('The in-browser vision library did not load. Check your connection and reload the page.');
    }
    if (!detectorPromise) {
        detectorPromise = window.cocoSsd.load({ base: 'mobilenet_v1' })
            .then((model) => {
                detector = model;
                return model;
            })
            .catch((error) => {
                detectorPromise = null;
                throw error;
            });
    }
    return detectorPromise;
}

async function analyzeCurrentFrame() {
    if (!analysisActive || inferenceInProgress ||
        elements.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
        elements.video.videoWidth === 0) {
        return;
    }

    const currentRun = analysisRun;
    inferenceInProgress = true;
    const startedAt = performance.now();
    try {
        const minimumScore = Number(elements.confidenceThreshold.value) / 100;
        const predictions = await detector.detect(elements.video, 20, minimumScore);
        if (!analysisActive || currentRun !== analysisRun) return;

        const relevantPredictions = predictions.filter((prediction) =>
            (prediction.class === 'person' || animalLabels.has(prediction.class))
        );
        const people = relevantPredictions.filter(({ class: label }) => label === 'person').length;
        const animals = relevantPredictions.length - people;
        const lowConfidenceCount = relevantPredictions.filter(
            (prediction) => prediction.score < 0.2
        ).length;
        const elapsed = performance.now() - startedAt;
        const time = elements.video.currentTime;

        drawDetections(relevantPredictions);
        elements.peopleCount.textContent = String(people);
        elements.animalCount.textContent = String(animals);
        elements.inferenceTime.textContent = `${elapsed.toFixed(0)} ms`;
        elements.detectionSummary.textContent = people + animals
            ? `Sampled frame at ${formatTime(time)}: ${people} people and ${animals} supported animals detected.${lowConfidenceCount ? ` ${lowConfidenceCount} low-confidence detection${lowConfidenceCount === 1 ? '' : 's'}; review the frame.` : ''}`
            : `No person or supported animal detected above the selected confidence threshold in the sampled frame at ${formatTime(time)}.`;
        storeFrameDetails(time, people, animals);
    } catch (error) {
        if (currentRun !== analysisRun) return;
        stopAnalysis('Frame analysis failed.');
        setStatus(elements.analysisStatus, `Frame analysis failed: ${error.message}`, true);
        console.error('Video frame analysis failed:', error);
    } finally {
        if (currentRun === analysisRun) inferenceInProgress = false;
    }
}

function startSampling() {
    window.clearInterval(analysisTimer);
    if (analysisActive && !analysisCompletedForVideo && !elements.video.paused) {
        analysisTimer = window.setInterval(analyzeCurrentFrame, 600);
    }
}

async function startAnalysis() {
    if (!elements.video.currentSrc) {
        setStatus(elements.analysisStatus, 'Choose a video before starting analysis.', true);
        return;
    }

    elements.analyzeButton.disabled = true;
    analysisCompletedForVideo = false;
    setStatus(elements.analysisStatus, 'Loading the browser-based object detector…');
    try {
        detector = await loadDetector();
        analysisActive = true;
        elements.stopAnalysisButton.disabled = false;
        setStatus(elements.analysisStatus, 'Analyzing sampled frames locally in this browser.');
        if (elements.video.paused) await elements.video.play();
        startSampling();
        await analyzeCurrentFrame();
    } catch (error) {
        analysisActive = false;
        elements.analyzeButton.disabled = false;
        elements.stopAnalysisButton.disabled = true;
        setStatus(elements.analysisStatus, `Could not start analysis: ${error.message}`, true);
        console.error('Could not start video analysis:', error);
    }
}

function appendWebRtcLog(message) {
    const line = document.createElement('li');
    line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    elements.webrtcLog.prepend(line);
    while (elements.webrtcLog.children.length > 12) {
        elements.webrtcLog.lastElementChild.remove();
    }
}

function waitForIceGatheringComplete(connection) {
    return new Promise((resolve, reject) => {
        if (connection.iceGatheringState === 'complete') {
            resolve();
            return;
        }

        const onStateChange = () => {
            if (connection.iceGatheringState === 'complete') {
                connection.removeEventListener('icegatheringstatechange', onStateChange);
                resolve();
            } else if (connection.signalingState === 'closed') {
                connection.removeEventListener('icegatheringstatechange', onStateChange);
                reject(new Error('Peer connection closed before ICE gathering completed.'));
            }
        };
        connection.addEventListener('icegatheringstatechange', onStateChange);
        onStateChange();
    });
}

function updateConnectionStates() {
    if (!peerConnection) return;
    elements.connectionState.textContent = peerConnection.connectionState;
    elements.iceState.textContent = peerConnection.iceConnectionState;
}

async function updateWebRtcStats() {
    if (!peerConnection || peerConnection.connectionState === 'closed') return;
    try {
        const stats = await peerConnection.getStats();
        let outboundVideo = null;
        let selectedPair = null;
        let remoteInbound = null;

        stats.forEach((report) => {
            if (report.type === 'outbound-rtp' && report.kind === 'video' && !report.isRemote) {
                outboundVideo = report;
                const codec = stats.get(report.codecId);
                if (codec?.mimeType) elements.codec.textContent = codec.mimeType;
            }
            if (report.type === 'candidate-pair' &&
                (report.selected || (report.nominated && report.state === 'succeeded'))) {
                selectedPair = report;
            }
            if (report.type === 'remote-inbound-rtp' && report.kind === 'video') {
                remoteInbound = report;
            }
        });

        const roundTripTime = remoteInbound?.roundTripTime ?? selectedPair?.currentRoundTripTime;
        elements.roundTripTime.textContent = Number.isFinite(roundTripTime)
            ? `${(roundTripTime * 1000).toFixed(0)} ms`
            : '—';

        const now = performance.now();
        if (outboundVideo && previousBytesSent !== null && previousStatsTime !== null) {
            const elapsedSeconds = (now - previousStatsTime) / 1000;
            const bitsPerSecond = (outboundVideo.bytesSent - previousBytesSent) * 8 / elapsedSeconds;
            elements.bitrate.textContent = Number.isFinite(bitsPerSecond) && elapsedSeconds > 0
                ? `${(bitsPerSecond / 1000).toFixed(0)} kbps`
                : '—';
        }
        previousBytesSent = outboundVideo?.bytesSent ?? null;
        previousStatsTime = now;
    } catch (error) {
        setStatus(elements.webrtcStatus, `Could not read WebRTC statistics: ${error.message}`, true);
        console.error('Could not read WebRTC statistics:', error);
    }
}

async function startWebRtcLoopback() {
    if (!elements.video.currentSrc || elements.video.readyState < HTMLMediaElement.HAVE_METADATA) {
        setStatus(elements.webrtcStatus, 'Choose a video before starting the loopback.', true);
        return;
    }

    const captureStream = elements.video.captureStream || elements.video.mozCaptureStream;
    if (typeof captureStream !== 'function' || typeof window.RTCPeerConnection !== 'function') {
        setStatus(elements.webrtcStatus, 'This browser does not support video capture or WebRTC loopback.', true);
        return;
    }

    elements.connectButton.disabled = true;
    setStatus(elements.webrtcStatus, 'Starting local peer-to-peer negotiation…');
    appendWebRtcLog('Creating two local peer connections; no signaling server or TURN service is used.');

    try {
        if (elements.video.paused) await elements.video.play();
        capturedStream = captureStream.call(elements.video);
        peerConnection = new RTCPeerConnection();
        remotePeerConnection = new RTCPeerConnection();
        const remoteConnection = remotePeerConnection;
        peerConnection.addEventListener('connectionstatechange', () => {
            updateConnectionStates();
        });
        remoteConnection.addEventListener('connectionstatechange', () => {
            if (peerConnection) {
                elements.connectionState.textContent =
                    `${peerConnection.connectionState} / ${remoteConnection.connectionState}`;
            }
        });
        peerConnection.addEventListener('iceconnectionstatechange', updateConnectionStates);
        remoteConnection.addEventListener('iceconnectionstatechange', () => {
            elements.iceState.textContent =
                `${peerConnection?.iceConnectionState || 'closed'} / ${remoteConnection.iceConnectionState}`;
        });
        remoteConnection.addEventListener('track', ({ streams, track }) => {
            elements.remoteVideo.srcObject = streams[0] || new MediaStream([track]);
            elements.remoteVideo.play().catch((error) => {
                setStatus(elements.webrtcStatus, `Remote playback needs interaction: ${error.message}`, true);
                console.error('Remote WebRTC video playback failed:', error);
            });
            appendWebRtcLog(`Received remote ${track.kind} track.`);
        });

        capturedStream.getTracks().forEach((track) => {
            peerConnection.addTrack(track, capturedStream);
        });

        appendWebRtcLog('Creating SDP offer.');
        await peerConnection.setLocalDescription(await peerConnection.createOffer());
        await waitForIceGatheringComplete(peerConnection);
        const localSdp = peerConnection.localDescription;
        await remoteConnection.setRemoteDescription(localSdp);
        appendWebRtcLog('Applied offer and gathered local ICE candidates.');

        await remoteConnection.setLocalDescription(await remoteConnection.createAnswer());
        await waitForIceGatheringComplete(remoteConnection);
        await peerConnection.setRemoteDescription(remoteConnection.localDescription);
        appendWebRtcLog('Applied answer; waiting for the local ICE pair to connect.');

        const candidateMatches = localSdp.sdp.match(/^a=candidate:/gm) || [];
        elements.candidateCount.textContent = String(candidateMatches.length);
        elements.disconnectButton.disabled = false;
        updateConnectionStates();
        await updateWebRtcStats();
        statsTimer = window.setInterval(updateWebRtcStats, 1000);
        setStatus(elements.webrtcStatus, 'Loopback negotiated locally. This is peer-to-peer, not an SFU.');
    } catch (error) {
        stopWebRtcLoopback();
        setStatus(elements.webrtcStatus, `WebRTC setup failed: ${error.message}`, true);
        appendWebRtcLog(`Negotiation failed: ${error.message}`);
        console.error('WebRTC loopback setup failed:', error);
    }
}

function stopWebRtcLoopback() {
    window.clearInterval(statsTimer);
    statsTimer = null;
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    if (remotePeerConnection) {
        remotePeerConnection.close();
        remotePeerConnection = null;
    }
    capturedStream?.getTracks().forEach((track) => track.stop());
    capturedStream = null;
    elements.remoteVideo.pause();
    elements.remoteVideo.srcObject = null;
    elements.connectButton.disabled = !elements.video.currentSrc;
    elements.disconnectButton.disabled = true;
    elements.connectionState.textContent = 'closed';
    elements.iceState.textContent = 'closed';
    elements.codec.textContent = '—';
    elements.roundTripTime.textContent = '—';
    elements.bitrate.textContent = '—';
    elements.candidateCount.textContent = '—';
    previousBytesSent = null;
    previousStatsTime = null;
}

elements.fileInput.addEventListener('change', () => {
    const [file] = elements.fileInput.files;
    if (!file) return;
    elements.fileInput.value = '';

    stopAnalysis('Video loading…');
    stopWebRtcLoopback();
    elements.video.pause();
    elements.video.removeAttribute('src');
    elements.video.load();
    if (videoObjectUrl) URL.revokeObjectURL(videoObjectUrl);
    videoObjectUrl = null;
    clearVideoError();
    clearDetectionState();
    elements.fileName.textContent = file.name;
    elements.analyzeButton.disabled = true;
    elements.connectButton.disabled = true;
    elements.timeline.disabled = true;
    elements.playButton.disabled = true;
    elements.speedButton.disabled = true;

    if (file.type && !file.type.startsWith('video/')) {
        showVideoError('This file is not a supported video. Choose a video file such as an MP4 encoded with H.264 video and AAC audio.');
        elements.fileInput.value = '';
        return;
    }

    videoObjectUrl = URL.createObjectURL(file);
    elements.video.src = videoObjectUrl;
    elements.video.load();
    updateTimeline();
    setStatus(elements.analysisStatus, 'Loading selected video…');
});

elements.video.addEventListener('loadedmetadata', () => {
    clearVideoError();
    updateTimeline();
    elements.timeline.disabled = false;
    elements.analyzeButton.disabled = false;
    elements.connectButton.disabled = false;
    elements.playButton.disabled = false;
    elements.speedButton.disabled = false;
    playbackSpeedIndex = 0;
    elements.video.playbackRate = playbackSpeeds[playbackSpeedIndex];
    playbackState.currentSpeed = playbackSpeeds[playbackSpeedIndex];
    elements.speedButton.textContent = `${playbackSpeeds[playbackSpeedIndex]}×`;
    elements.speedButton.setAttribute('aria-label', `Playback speed ${playbackSpeeds[playbackSpeedIndex]}x`);
    updatePlayButton();
    setStatus(elements.analysisStatus, 'Video ready. Start analysis when you are ready.');
});

elements.video.addEventListener('timeupdate', updateTimeline);
elements.video.addEventListener('play', startSampling);
elements.video.addEventListener('play', updatePlayButton);
elements.video.addEventListener('pause', () => {
    window.clearInterval(analysisTimer);
    analysisTimer = null;
    updatePlayButton();
});
elements.video.addEventListener('ended', updatePlayButton);
elements.video.addEventListener('ended', () => {
    if (!analysisActive) return;
    analysisCompletedForVideo = true;
    stopAnalysis('Analysis complete. Replaying this video will not count its sampled frames again.');
});
elements.video.addEventListener('seeked', () => {
    if (analysisActive && !analysisCompletedForVideo) analyzeCurrentFrame();
});
elements.video.addEventListener('error', () => {
    if (!videoObjectUrl || elements.video.currentSrc !== videoObjectUrl) return;
    stopAnalysis('Video playback failed.');
    stopWebRtcLoopback();

    const errorCode = elements.video.error?.code;
    const message = errorCode === MediaError.MEDIA_ERR_ABORTED
        ? 'Video loading was interrupted. Choose the file again to retry.'
        : errorCode === MediaError.MEDIA_ERR_NETWORK
            ? 'The browser could not read this video file. Check the file and try again.'
            : 'This video is not supported or may be corrupted. Try an MP4 file encoded with H.264 video and AAC audio.';
    showVideoError(message);
});

elements.playButton.addEventListener('click', async () => {
    if (elements.video.paused) {
        try {
            await elements.video.play();
        } catch (error) {
            showVideoError(`Video playback could not start: ${error.message}`);
            console.error('Video playback failed:', error);
        }
    } else {
        elements.video.pause();
    }
});

elements.speedButton.addEventListener('click', () => {
    playbackSpeedIndex = (playbackSpeedIndex + 1) % playbackSpeeds.length;
    const speed = playbackSpeeds[playbackSpeedIndex];
    elements.video.playbackRate = speed;
    playbackState.currentSpeed = speed;
    elements.speedButton.textContent = `${speed}×`;
    elements.speedButton.setAttribute('aria-label', `Playback speed ${speed}x`);
});

elements.timeline.addEventListener('input', () => {
    elements.video.currentTime = Number(elements.timeline.value);
});
elements.confidenceThreshold.addEventListener('input', () => {
    elements.confidenceValue.textContent = `${elements.confidenceThreshold.value}%`;
});
elements.analyzeButton.addEventListener('click', startAnalysis);
elements.stopAnalysisButton.addEventListener('click', () => stopAnalysis());
elements.connectButton.addEventListener('click', startWebRtcLoopback);
elements.disconnectButton.addEventListener('click', () => {
    stopWebRtcLoopback();
    setStatus(elements.webrtcStatus, 'Loopback stopped and media tracks released.');
    appendWebRtcLog('Closed peer connection and stopped captured tracks.');
});

window.addEventListener('beforeunload', () => {
    stopAnalysis();
    stopWebRtcLoopback();
    if (videoObjectUrl) URL.revokeObjectURL(videoObjectUrl);
});
