// Fresh room name each page load so LiveKit dispatches a new agent
const ROOM_NAME = 'habla-' + Date.now();
const PARTICIPANT_IDENTITY = 'learner';

const connectBtn = document.getElementById('connect-btn');
const pttBtn = document.getElementById('ptt-btn');
const debugRefreshBtn = document.getElementById('debug-refresh-btn');
const endSessionBtn = document.getElementById('end-session-btn');
const transcriptPanel = document.getElementById('transcript-panel');
const transcriptEmptyEl = document.getElementById('transcript-empty');
const agentStateEl = document.getElementById('agent-state');
const connectionStatusEl = document.getElementById('connection-status');

/** Hide the "Press Connect to start" empty-state on first turn or first event. */
function clearEmptyState() {
  if (transcriptEmptyEl && transcriptEmptyEl.parentNode) {
    transcriptEmptyEl.remove();
  }
}

// Debug panel elements
const debugMetricsEl = document.getElementById('debug-metrics');
const debugFsrsEl = document.getElementById('debug-fsrs');
const debugLearnerEl = document.getElementById('debug-learner');
const debugTutorEl = document.getElementById('debug-tutor');
const debugPromptEl = document.getElementById('debug-prompt');
const debugControllerEl = document.getElementById('debug-controller');
const debugPronunciationEl = document.getElementById('debug-pronunciation');
const pronProviderBadgeEl = document.getElementById('pron-provider-badge');
const fsrsCountEl = document.getElementById('fsrs-count');
const learnerVersionEl = document.getElementById('learner-version');
const tutorVersionEl = document.getElementById('tutor-version');

// Compaction result elements
const compactionResultSection = document.getElementById('compaction-result-section');
const compactionStatusEl = document.getElementById('compaction-status');
const compactionDiffEl = document.getElementById('compaction-diff');
const compactionFsrsEl = document.getElementById('compaction-fsrs');

let room = null;
let isConnected = false;
let isPttActive = false;
let agentIdentity = null;

// Group learner segments into a single turn element
let currentLearnerTurn = null;
let learnerSegmentTexts = new Map();

// Track tutor segments by ID for interim updates
const segmentElements = new Map();

// ── Connect ─────────────────────────────────────────────────────────

connectBtn.addEventListener('click', async () => {
  if (isConnected) return;

  connectBtn.textContent = 'Connecting...';
  connectBtn.disabled = true;
  setMicStatus('requesting', 'Requesting mic permission...');

  try {
    // Request mic permission BEFORE connecting to LiveKit so that a denial
    // is surfaced cleanly rather than silently caught after WebRTC is up.
    let micStream;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      // We don't actually use this stream — LiveKit will request its own.
      // We just needed the permission prompt to resolve.
      micStream.getTracks().forEach((t) => t.stop());
    } catch (micErr) {
      console.error('Microphone permission denied:', micErr);
      setMicStatus(
        'denied',
        micErr.name === 'NotAllowedError'
          ? 'Mic blocked. Click the camera/mic icon in the URL bar → Allow → reload.'
          : `Mic error: ${micErr.message || micErr.name}`,
      );
      connectBtn.textContent = 'Connect';
      connectBtn.disabled = false;
      return;
    }

    const resp = await fetch(
      `/api/token?room=${ROOM_NAME}&identity=${PARTICIPANT_IDENTITY}`,
    );
    const { token, url } = await resp.json();

    room = new LivekitClient.Room({
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true },
      adaptiveStream: true,
    });

    setupRoomEvents(room);

    await room.connect(url, token);

    try {
      await room.localParticipant.setMicrophoneEnabled(true);
      setMicStatus('live', 'Mic live');
      // Hook a VU meter to the published track so you can SEE if your voice
      // is actually being captured. Solves the silent "mic on but no transcript"
      // failure mode where the OS-level input device is wrong or muted.
      attachAudioMeter().catch((e) =>
        console.warn('VU meter attach failed:', e),
      );
    } catch (micErr) {
      console.error('setMicrophoneEnabled failed:', micErr);
      setMicStatus('denied', `Failed to publish mic: ${micErr.message || micErr}`);
      // Connection is up but mic isn't — disconnect to avoid a half-broken state.
      await room.disconnect();
      connectBtn.textContent = 'Connect';
      connectBtn.disabled = false;
      return;
    }

    isConnected = true;
    connectBtn.textContent = 'Connected';
    connectBtn.classList.add('connected');
    connectionStatusEl.textContent = 'In session';
    connectionStatusEl.classList.add('connected');
    pttBtn.disabled = false;
    debugRefreshBtn.disabled = false;
    endSessionBtn.disabled = false;

    // Fetch initial debug snapshot after giving the agent a moment to join
    setTimeout(refreshDebugSnapshot, 2000);
  } catch (err) {
    console.error('Connection failed:', err);
    setMicStatus('error', `Connection failed: ${err.message || err}`);
    connectBtn.textContent = 'Connect';
    connectBtn.disabled = false;
    connectionStatusEl.textContent = 'Connection failed';
  }
});

/**
 * Continuous VU meter on the published mic track. Lets you see whether your
 * voice is actually reaching LiveKit — the single hardest failure to diagnose
 * is "mic permission granted, track published, but the audio is silent."
 */
let _meterCleanup = null;
async function attachAudioMeter() {
  if (_meterCleanup) _meterCleanup();

  const pubs = Array.from(room.localParticipant.audioTrackPublications.values());
  if (pubs.length === 0) throw new Error('no audio track to meter');
  const track = pubs[0].track;
  const mediaTrack = track?.mediaStreamTrack;
  if (!mediaTrack) throw new Error('no MediaStreamTrack on audio publication');

  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const stream = new MediaStream([mediaTrack]);
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.6;
  source.connect(analyser);

  // Inject the meter UI under the PTT button if not present
  let meter = document.getElementById('mic-meter');
  if (!meter) {
    meter = document.createElement('div');
    meter.id = 'mic-meter';
    meter.innerHTML =
      '<div class="meter-track"><div class="meter-fill"></div></div>' +
      '<div class="meter-label">mic level</div>';
    pttBtn.parentNode.insertBefore(meter, pttBtn.nextSibling);
  }
  const fill = meter.querySelector('.meter-fill');
  const label = meter.querySelector('.meter-label');

  const data = new Uint8Array(analyser.frequencyBinCount);
  let rafId;
  let frameSilenceCount = 0;
  const SILENCE_THRESHOLD = 0.003;
  const SILENCE_FRAMES_BEFORE_HINT = 180; // ~3s of silence after PTT start
  let lastHintAt = 0;

  function tick() {
    analyser.getByteTimeDomainData(data);
    let sumSq = 0;
    for (let i = 0; i < data.length; i++) {
      const v = (data[i] - 128) / 128;
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / data.length);
    // Compressed display so quiet speech still shows movement
    const pct = Math.min(100, Math.pow(rms * 3, 0.6) * 100);
    fill.style.width = pct + '%';
    fill.classList.toggle('meter-fill--hot', rms > 0.05);
    fill.classList.toggle('meter-fill--cold', rms < SILENCE_THRESHOLD);

    if (isPttActive) {
      if (rms < SILENCE_THRESHOLD) {
        frameSilenceCount++;
      } else {
        frameSilenceCount = 0;
      }
      if (
        frameSilenceCount > SILENCE_FRAMES_BEFORE_HINT &&
        Date.now() - lastHintAt > 5000
      ) {
        label.textContent =
          'mic level — silent. Check Windows mic device + speak closer';
        label.classList.add('meter-label--warn');
        lastHintAt = Date.now();
      } else if (rms >= SILENCE_THRESHOLD) {
        label.textContent = 'mic level';
        label.classList.remove('meter-label--warn');
      }
    }

    rafId = requestAnimationFrame(tick);
  }
  tick();

  _meterCleanup = () => {
    cancelAnimationFrame(rafId);
    try {
      source.disconnect();
      ctx.close();
    } catch {
      // ignore — page may be unloading
    }
  };
}

/**
 * Surface mic/connection state in a banner above the transcript so failures
 * aren't buried in the console. State is one of:
 *   requesting | live | denied | error | hidden
 */
function setMicStatus(state, message) {
  let banner = document.getElementById('mic-status-banner');
  if (state === 'hidden') {
    if (banner) banner.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'mic-status-banner';
    transcriptPanel.parentNode.insertBefore(banner, transcriptPanel);
  }
  banner.className = `mic-status-banner mic-status-${state}`;
  banner.textContent = message;
  // "Live" state fades out after a moment — no need to keep the badge visible
  // forever once mic is working.
  if (state === 'live') {
    setTimeout(() => {
      if (banner && banner.classList.contains('mic-status-live')) {
        banner.style.opacity = '0';
        setTimeout(() => banner && banner.remove(), 600);
      }
    }, 1500);
  }
}

debugRefreshBtn.addEventListener('click', refreshDebugSnapshot);

endSessionBtn.addEventListener('click', async () => {
  if (!isConnected) return;
  const target = findAgentIdentity();
  if (!target) {
    alert('No agent found in room');
    return;
  }

  const confirmed = confirm(
    'End this session and trigger compaction? This will take ~8-15 seconds while Claude Sonnet processes the transcript.',
  );
  if (!confirmed) return;

  endSessionBtn.disabled = true;
  endSessionBtn.classList.add('compacting');
  endSessionBtn.textContent = 'Compacting...';
  pttBtn.disabled = true;

  try {
    const resp = await room.localParticipant.performRpc({
      destinationIdentity: target,
      method: 'end_session',
      payload: '',
      responseTimeout: 60000, // Compaction can take 15+ seconds
    });
    const data = JSON.parse(resp);
    renderCompactionResult(data);

    if (data.ok) {
      // Refresh debug panel to show evolved cores
      await refreshDebugSnapshot();
    }
  } catch (err) {
    console.error('End session failed:', err);
    compactionResultSection.style.display = 'block';
    compactionStatusEl.textContent = `Error: ${err.message || err}`;
  } finally {
    endSessionBtn.classList.remove('compacting');
    endSessionBtn.textContent = 'Ended';
  }
});

// ── Room Events ─────────────────────────────────────────────────────

function setupRoomEvents(room) {
  const RoomEvent = LivekitClient.RoomEvent;

  room.on(RoomEvent.Disconnected, () => {
    isConnected = false;
    isPttActive = false;
    pttBtn.disabled = true;
    pttBtn.classList.remove('active');
    pttBtn.textContent = 'Hold to speak';
    debugRefreshBtn.disabled = true;
    endSessionBtn.disabled = true;
    connectBtn.textContent = 'Connect';
    connectBtn.disabled = false;
    connectBtn.classList.remove('connected');
    connectionStatusEl.textContent = 'Not connected';
    connectionStatusEl.classList.remove('connected');
    agentStateEl.textContent = 'Sofía has left';
    agentStateEl.className = '';
  });

  room.on(RoomEvent.ParticipantConnected, (participant) => {
    if (participant.attributes && participant.attributes['lk.agent.state']) {
      agentIdentity = participant.identity;
      updateAgentState(participant.attributes['lk.agent.state']);
      // Auto-refresh debug when agent joins
      setTimeout(refreshDebugSnapshot, 500);
    }
  });

  room.on(RoomEvent.ParticipantAttributesChanged, (changed, participant) => {
    if (changed['lk.agent.state']) {
      agentIdentity = participant.identity;
      updateAgentState(changed['lk.agent.state']);
    }
  });

  room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
    if (track.kind === 'audio') {
      const el = track.attach();
      el.id = `audio-${participant.identity}`;
      // Hide the default audio control bar — Sofía's voice plays automatically
      // and we don't want the chrome poking out at the bottom of the page.
      el.style.display = 'none';
      el.setAttribute('aria-hidden', 'true');
      document.body.appendChild(el);
    }
  });

  room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
    if (track.kind === 'audio') {
      track.detach().forEach((el) => el.remove());
    }
  });

  room.on(RoomEvent.TranscriptionReceived, (segments, participant) => {
    const isAgent =
      participant && participant.identity !== PARTICIPANT_IDENTITY;

    for (const segment of segments) {
      if (isAgent) {
        updateTutorSegment(segment.id, segment.text, segment.final);
      } else {
        updateLearnerSegment(segment.id, segment.text, segment.final);
      }
    }
  });

  room.on(RoomEvent.Connected, () => {
    for (const [, participant] of room.remoteParticipants) {
      if (participant.attributes && participant.attributes['lk.agent.state']) {
        agentIdentity = participant.identity;
        updateAgentState(participant.attributes['lk.agent.state']);
        break;
      }
    }
  });
}

// ── Push-to-Talk ────────────────────────────────────────────────────

async function pttStart() {
  if (!isConnected || isPttActive) return;

  const target = findAgentIdentity();
  if (!target) {
    // Don't even visually enter the listening state — the agent isn't there
    // to receive the audio. Surface a clear hint instead of failing silently.
    setMicStatus('error', 'Sofía is still connecting — try again in a moment.');
    return;
  }

  isPttActive = true;
  pttBtn.classList.add('active');
  pttBtn.textContent = 'Listening…';

  clearEmptyState();
  currentLearnerTurn = document.createElement('div');
  currentLearnerTurn.className = 'transcript-entry learner interim';
  currentLearnerTurn.innerHTML =
    '<div class="speaker">You</div><div class="text"></div>';
  transcriptPanel.appendChild(currentLearnerTurn);
  learnerSegmentTexts.clear();

  try {
    await room.localParticipant.performRpc({
      destinationIdentity: target,
      method: 'ptt_start',
      payload: '',
    });
  } catch (err) {
    console.error('RPC ptt_start failed:', err);
    // Clean up the empty interim bubble so the user doesn't stare at a ghost.
    if (currentLearnerTurn) currentLearnerTurn.remove();
    currentLearnerTurn = null;
    isPttActive = false;
    pttBtn.classList.remove('active');
    pttBtn.textContent = 'Hold to speak';
  }
}

async function pttEnd() {
  if (!isPttActive) return;
  isPttActive = false;
  pttBtn.classList.remove('active');
  pttBtn.textContent = 'Hold to speak';

  if (currentLearnerTurn) {
    currentLearnerTurn.classList.remove('interim');
    const text = currentLearnerTurn.querySelector('.text').textContent;
    if (!text.trim()) {
      currentLearnerTurn.remove();
    }
    currentLearnerTurn = null;
  }

  const target = findAgentIdentity();
  if (!target) return;

  try {
    await room.localParticipant.performRpc({
      destinationIdentity: target,
      method: 'ptt_end',
      payload: '',
    });
    // Pronunciation results land ~1.2s after PTT_end (Azure round-trip). Poll
    // at multiple intervals so the bubble gets annotated whenever the result
    // arrives — short turns sometimes return in <500ms, long turns can take
    // 2-3s. Multi-poll is cheap and idempotent.
    for (const delay of [400, 1500, 3500, 6000]) {
      setTimeout(refreshDebugSnapshot, delay);
    }
  } catch (err) {
    console.error('RPC ptt_end failed:', err);
  }
}

// Unified pointer + keyboard input for push-to-talk. The previous mousedown +
// touchstart pair double-fired on hybrid devices; pointer events normalize the
// two streams. We capture the pointer so the release event fires even if the
// finger/cursor slides off the button mid-hold (otherwise PTT got stuck open).
pttBtn.addEventListener('pointerdown', (e) => {
  if (pttBtn.disabled) return;
  e.preventDefault();
  pttBtn.setPointerCapture?.(e.pointerId);
  pttStart();
});
const releasePointer = (e) => {
  if (!isPttActive) return;
  e.preventDefault();
  try { pttBtn.releasePointerCapture?.(e.pointerId); } catch { /* noop */ }
  pttEnd();
};
pttBtn.addEventListener('pointerup', releasePointer);
pttBtn.addEventListener('pointercancel', releasePointer);
// `pointerleave` is intentionally not bound — when we have pointer capture the
// pointer cannot leave the button as far as the event system is concerned, so
// the up/cancel handlers above are enough.

// Spacebar PTT — feels closer to a real conversation than holding the mouse.
// Window-level so the user doesn't have to focus the button first. ignored
// when the user is typing into a form field.
function isTypingTarget(target) {
  if (!target) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable
  );
}
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.repeat) return;
  if (pttBtn.disabled || isTypingTarget(e.target)) return;
  e.preventDefault();
  pttStart();
});
window.addEventListener('keyup', (e) => {
  if (e.code !== 'Space') return;
  if (!isPttActive || isTypingTarget(e.target)) return;
  e.preventDefault();
  pttEnd();
});
// If the tab loses focus while PTT is held, end the turn cleanly so the agent
// doesn't sit "listening" forever.
window.addEventListener('blur', () => {
  if (isPttActive) pttEnd();
});

// ── Debug Panel ─────────────────────────────────────────────────────

async function refreshDebugSnapshot() {
  if (!isConnected) return;
  const target = findAgentIdentity();
  if (!target) {
    console.warn('Cannot refresh debug: no agent in room yet');
    return;
  }

  try {
    const resp = await room.localParticipant.performRpc({
      destinationIdentity: target,
      method: 'debug_snapshot',
      payload: '',
    });
    const data = JSON.parse(resp);
    renderDebugPanel(data);
  } catch (err) {
    console.error('Debug snapshot failed:', err);
  }
}

function renderDebugPanel(data) {
  // Difficulty controller (Phase 6)
  renderControllerState(data.controllerState);

  // Pronunciation pipeline (Phase 7)
  renderPronunciation(data.pronunciation);

  // Metrics
  const durationSec = Math.floor(
    (Date.now() - new Date(data.sessionStartedAt).getTime()) / 1000,
  );
  debugMetricsEl.textContent =
    `Learner ID: ${data.learnerId.slice(0, 8)}...\n` +
    `Session ID: ${data.sessionId.slice(0, 8)}...\n` +
    `Turn count: ${data.turnCount}\n` +
    `Duration: ${durationSec}s`;

  // FSRS items
  fsrsCountEl.textContent = `(${data.fsrsDueItems.length})`;
  if (data.fsrsDueItems.length === 0) {
    debugFsrsEl.textContent = 'No items due';
  } else {
    debugFsrsEl.innerHTML = data.fsrsDueItems
      .map(
        (i) =>
          `<div class="fsrs-item"><span class="fsrs-key">${escapeHtml(i.item_key)}</span>` +
          (i.item_context
            ? `<div class="fsrs-context">${escapeHtml(i.item_context)}</div>`
            : '') +
          `</div>`,
      )
      .join('');
  }

  // Learner core
  learnerVersionEl.textContent = `v${data.learnerCore.version}`;
  debugLearnerEl.textContent = JSON.stringify(data.learnerCore, null, 2);

  // Tutor core
  tutorVersionEl.textContent = `v${data.tutorCore.version}`;
  debugTutorEl.textContent = JSON.stringify(data.tutorCore, null, 2);

  // System prompt
  debugPromptEl.textContent = data.systemPrompt;
}

function renderPronunciation(pron) {
  if (!pron) {
    debugPronunciationEl.textContent = 'Pipeline not initialized';
    pronProviderBadgeEl.textContent = '';
    return;
  }

  // Provider badge
  pronProviderBadgeEl.textContent = pron.provider;
  pronProviderBadgeEl.className =
    'provider-badge ' +
    (pron.provider === 'noop' ? 'provider-noop' : 'provider-active');

  if (!pron.recent || pron.recent.length === 0) {
    debugPronunciationEl.innerHTML =
      pron.provider === 'noop'
        ? '<div class="muted">No assessor configured. Set PRONUNCIATION_PROVIDER=azure (or speechace) to enable.</div>'
        : '<div class="muted">No turns assessed yet — speak something to see scores.</div>';
    return;
  }

  // Debug-panel summary view (compact, most-recent-first)
  const items = [...pron.recent].reverse().map((a, idx) => {
    const accuracyClass = scoreBucket(a.overall.accuracy);
    const flagged = (a.words || []).filter(
      (w) => w.score < 70 || w.error_type !== 'None',
    );

    const flaggedHtml =
      flagged.length > 0
        ? flagged
            .map(
              (w) =>
                `<span class="pron-flag pron-flag-${scoreBucket(w.score)}" ` +
                `title="${escapeHtml(w.error_type)}${w.phoneme_sub ? ` /${w.phoneme_sub.from}/→/${w.phoneme_sub.to}/` : ''}">` +
                `${escapeHtml(w.word)} ${w.score}</span>`,
            )
            .join('')
        : '<span class="muted">no flags</span>';

    const prosodyHtml = a.prosody?.errors?.length
      ? `<div class="pron-prosody">prosody: ${a.prosody.errors
          .map((e) => escapeHtml(e.type))
          .join(', ')}</div>`
      : '';

    const divergenceHtml = a.divergence
      ? `<div class="pron-divergence" title="STT and Azure disagreed on what was said">heard: "${escapeHtml(a.recognized_text || '')}"</div>`
      : '';

    return (
      `<div class="pron-turn ${idx === 0 ? 'pron-turn-latest' : ''}">` +
      `<div class="pron-text">"${escapeHtml(a.reference_text)}"</div>` +
      `<div class="pron-scores">` +
      `<span class="pron-score score-${accuracyClass}">accuracy ${Math.round(a.overall.accuracy)}</span>` +
      `<span class="pron-score">fluency ${Math.round(a.overall.fluency)}</span>` +
      `<span class="muted">${a.latency_ms}ms</span>` +
      `</div>` +
      `<div class="pron-flagged">${flaggedHtml}</div>` +
      divergenceHtml +
      prosodyHtml +
      `</div>`
    );
  });

  debugPronunciationEl.innerHTML = items.join('');

  // Annotate the actual transcript bubbles — what the user sees inline.
  // Match assessments to bubbles by reference_text (latest-N pairing).
  annotateLearnerBubbles(pron.recent);
}

/**
 * Score-to-bucket mapping shared by the debug-panel pills and the inline
 * transcript word tints. Five buckets so the gradient feels granular.
 */
function scoreBucket(score) {
  if (score >= 85) return 'clean';
  if (score >= 70) return 'mild';
  if (score >= 55) return 'mid';
  if (score >= 40) return 'rough';
  return 'severe';
}

/**
 * Walk recent learner transcript bubbles and overlay per-word annotations
 * from matching assessments. Match by reference_text trimmed of punctuation.
 *
 * Idempotent — call as many times as you like; each call rebuilds the bubble
 * contents from the stored raw text + latest assessment.
 */
function annotateLearnerBubbles(assessments) {
  if (!assessments || assessments.length === 0) return;

  const bubbles = Array.from(
    transcriptPanel.querySelectorAll('.transcript-entry.learner'),
  );
  if (bubbles.length === 0) return;

  const norm = (s) => (s || '').replace(/[.,!?;:¿¡]/g, '').trim().toLowerCase();

  // Index assessments by normalized reference for O(1) match
  const assessmentByRef = new Map();
  for (const a of assessments) {
    assessmentByRef.set(norm(a.reference_text), a);
  }

  for (const bubble of bubbles) {
    const textEl = bubble.querySelector('.text');
    if (!textEl) continue;

    // Stash original text on first encounter so we can re-render idempotently.
    if (!bubble.dataset.rawText) {
      bubble.dataset.rawText = textEl.textContent;
    }
    const raw = bubble.dataset.rawText;
    const assessment = assessmentByRef.get(norm(raw));
    if (!assessment) continue;

    textEl.innerHTML = renderAnnotatedText(raw, assessment);
  }
}

/**
 * Tokenize the raw transcript, match each token to a word in the assessment,
 * and emit a span tree with gradient-tint classes + inline bracket annotations.
 *
 * Whitespace and punctuation are preserved as plain text nodes between word
 * spans so the bubble reads naturally.
 */
function renderAnnotatedText(text, assessment) {
  // Split keeping delimiters so we preserve spacing/punctuation exactly
  const tokens = text.split(/(\s+|[.,!?;:¿¡]+)/);
  const wordsByLower = new Map();
  for (const w of assessment.words || []) {
    wordsByLower.set(w.word.toLowerCase().replace(/[.,!?;:¿¡]/g, ''), w);
  }

  const parts = tokens.map((tok) => {
    const cleanLower = tok.toLowerCase().replace(/[.,!?;:¿¡]/g, '');
    const match = wordsByLower.get(cleanLower);
    if (!match || !cleanLower) return escapeHtml(tok);

    const bucket = scoreBucket(match.score);
    const isStretch = match.is_stretch;
    const isErr = match.error_type && match.error_type !== 'None';
    const isMispron = bucket === 'mid' || bucket === 'rough' || bucket === 'severe' || isErr;
    const classNames = [
      'word',
      isStretch ? 'word--stretch' : `word--${bucket}`,
      isErr ? 'word--error' : '',
    ]
      .filter(Boolean)
      .join(' ');

    // Inline bracket: only render when there's something useful to say.
    const bracketParts = [];
    if (isMispron) bracketParts.push(String(match.score));
    if (match.phoneme_sub) {
      bracketParts.push(`/${match.phoneme_sub.from}/→/${match.phoneme_sub.to}/`);
    }
    if (isStretch) bracketParts.push('stretch');
    const bracket =
      bracketParts.length > 0
        ? `<span class="word-annot">[${bracketParts.join(' ')}]</span>`
        : '';

    const titleBits = [
      `score ${match.score}`,
      match.error_type !== 'None' ? match.error_type : null,
      match.phoneme_sub ? `/${match.phoneme_sub.from}/ → /${match.phoneme_sub.to}/` : null,
      isStretch ? 'above your usual level — nice' : null,
    ].filter(Boolean);
    const titleAttr = titleBits.length
      ? ` title="${escapeHtml(titleBits.join(' · '))}"`
      : '';

    return `<span class="${classNames}"${titleAttr}>${escapeHtml(tok)}</span>${bracket}`;
  });

  let html = parts.join('');

  // Divergence: STT and Azure disagreed on what was said. Annotate the whole
  // bubble at the tail rather than per-word, since we can't easily map which
  // specific word(s) caused the divergence.
  if (assessment.divergence && assessment.recognized_text) {
    html +=
      `<span class="bubble-annot bubble-annot--divergence" ` +
      `title="The pronunciation engine heard something different from speech-to-text">` +
      `[heard: ${escapeHtml(assessment.recognized_text)}]</span>`;
  }
  if (assessment.prosody?.errors?.length) {
    html +=
      `<span class="bubble-annot bubble-annot--prosody">` +
      `[prosody: ${escapeHtml(assessment.prosody.errors.map((e) => e.type).join(', '))}]</span>`;
  }

  return html;
}

function renderControllerState(state) {
  if (!state) {
    debugControllerEl.textContent = 'Controller not initialized';
    return;
  }

  const ratioPct = Math.round(state.current_ratio_target * 100);
  const edgeBadgeClass = `edge-badge edge-${state.edge_state}`;
  const edgeLabel =
    state.edge_state === 'unknown'
      ? 'awaiting first edge check'
      : state.edge_state;

  debugControllerEl.innerHTML =
    `<div class="ratio-row">` +
    `<div class="ratio-bar"><div class="ratio-fill" style="width: ${ratioPct}%"></div></div>` +
    `<div class="ratio-label">${ratioPct}% English / ${100 - ratioPct}% Spanish</div>` +
    `</div>` +
    `<div class="edge-row"><span class="${edgeBadgeClass}">${escapeHtml(edgeLabel)}</span>` +
    (state.last_edge_check_turn > 0
      ? ` <span class="muted">(last check: turn ${state.last_edge_check_turn})</span>`
      : '') +
    `</div>` +
    (state.last_evaluated_turn > 0
      ? `<div class="controller-reason"><strong>Last turn read:</strong> ${escapeHtml(state.last_turn_reason)}</div>`
      : '') +
    (state.edge_state !== 'unknown'
      ? `<div class="controller-reason"><strong>Directive:</strong> ${escapeHtml(state.last_edge_reason)}</div>`
      : '');
}

function renderCompactionResult(data) {
  compactionResultSection.style.display = 'block';

  if (!data.ok) {
    compactionStatusEl.textContent = `Failed: ${data.error || 'unknown error'}`;
    return;
  }

  compactionStatusEl.innerHTML =
    `<div><span class="diff-field">Duration:</span> ${(data.durationMs / 1000).toFixed(1)}s</div>` +
    `<div><span class="diff-field">FSRS created:</span> ${data.fsrsCreated}</div>` +
    `<div><span class="diff-field">FSRS rated:</span> ${data.fsrsRated}</div>` +
    `<div style="margin-top: 6px;"><span class="diff-field">Compaction notes:</span></div>` +
    `<div style="margin-top: 2px; color: #ccc;">${escapeHtml(data.compactionNotes)}</div>`;

  // Render a focused diff for the fields that matter most
  const diffs = [];
  const pre = data.preCores;
  const post = data.postCores;

  diffs.push(
    makeDiff(
      'Learner version',
      pre.learner.version,
      post.learner.version,
    ),
  );
  diffs.push(
    makeDiff(
      'Tutor version',
      pre.tutor.version,
      post.tutor.version,
    ),
  );
  diffs.push(
    makeDiff(
      'CEFR level',
      pre.learner.proficiency?.cefr_level,
      post.learner.proficiency?.cefr_level,
    ),
  );
  diffs.push(
    makeDiff(
      'Interests',
      JSON.stringify(pre.learner.learning_profile?.interests || []),
      JSON.stringify(post.learner.learning_profile?.interests || []),
    ),
  );
  diffs.push(
    makeDiff(
      'Active vocab',
      pre.learner.vocabulary?.active_count,
      post.learner.vocabulary?.active_count,
    ),
  );
  diffs.push(
    makeDiff(
      'Comfort zones',
      JSON.stringify(pre.learner.vocabulary?.comfort_zones || []),
      JSON.stringify(post.learner.vocabulary?.comfort_zones || []),
    ),
  );
  diffs.push(
    makeDiff(
      'Session trajectory',
      pre.learner.session_trajectory,
      post.learner.session_trajectory,
    ),
  );
  diffs.push(
    makeDiff(
      'Teaching narrative',
      pre.tutor.teaching_narrative,
      post.tutor.teaching_narrative,
    ),
  );

  compactionDiffEl.innerHTML = diffs.join('');

  // FSRS updates
  if (data.fsrsUpdates && data.fsrsUpdates.length > 0) {
    compactionFsrsEl.textContent = data.fsrsUpdates
      .map((u) => {
        if (u.action === 'create') {
          return `+ CREATE ${u.item_key}${u.context ? ` (${u.context})` : ''}`;
        } else {
          return `~ RATE ${u.item_key} = ${u.rating}`;
        }
      })
      .join('\n');
  } else {
    compactionFsrsEl.textContent = 'No FSRS updates';
  }
}

function makeDiff(field, oldVal, newVal) {
  const same = JSON.stringify(oldVal) === JSON.stringify(newVal);
  if (same) {
    return `<div class="diff-entry"><span class="diff-field">${field}:</span> <span style="color:#888;">${escapeHtml(String(oldVal ?? '—')).slice(0, 120)}</span></div>`;
  }
  return (
    `<div class="diff-entry"><span class="diff-field">${field}</span>` +
    `<span class="diff-old">${escapeHtml(String(oldVal ?? '—')).slice(0, 200)}</span>` +
    `<span class="diff-new">${escapeHtml(String(newVal ?? '—')).slice(0, 200)}</span></div>`
  );
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Helpers ─────────────────────────────────────────────────────────

function findAgentIdentity() {
  if (agentIdentity) return agentIdentity;
  if (!room) return null;

  for (const [, participant] of room.remoteParticipants) {
    if (participant.attributes && participant.attributes['lk.agent.state']) {
      agentIdentity = participant.identity;
      return agentIdentity;
    }
  }
  return null;
}

function updateAgentState(state) {
  // Phrasing matches how a person would describe a friend across the table —
  // not a status console. Keeps the conversation feeling like a conversation.
  const labels = {
    initializing: 'Sofía is joining…',
    idle: 'Sofía is ready',
    listening: 'Sofía is listening',
    thinking: 'Sofía is thinking…',
    speaking: 'Sofía is speaking',
  };
  agentStateEl.textContent = labels[state] || state;
  agentStateEl.className = `state-${state}`;
}

function updateTutorSegment(segmentId, text, isFinal) {
  let el = segmentElements.get(segmentId);

  if (!el) {
    clearEmptyState();
    el = document.createElement('div');
    el.className = 'transcript-entry tutor interim';
    el.innerHTML = '<div class="speaker">Sofía</div><div class="text"></div>';
    transcriptPanel.appendChild(el);
    segmentElements.set(segmentId, el);
  }

  el.querySelector('.text').textContent = text;

  if (isFinal) {
    el.classList.remove('interim');
  }

  transcriptPanel.scrollTop = transcriptPanel.scrollHeight;
}

function updateLearnerSegment(segmentId, text, isFinal) {
  learnerSegmentTexts.set(segmentId, text);

  if (currentLearnerTurn) {
    const combined = Array.from(learnerSegmentTexts.values()).join(' ');
    currentLearnerTurn.querySelector('.text').textContent = combined;
    transcriptPanel.scrollTop = transcriptPanel.scrollHeight;
  }
}
