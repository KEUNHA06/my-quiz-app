(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const els = {
    fileInput: $("fileInput"), fileName: $("fileName"), fileInfo: $("fileInfo"),
    savedStatus: $("savedStatus"), clearProgress: $("clearProgress"),
    voiceSelect: $("voiceSelect"), refreshVoices: $("refreshVoices"),
    rateSelect: $("rateSelect"), seekBar: $("seekBar"),
    currentTime: $("currentTime"), totalTime: $("totalTime"), progressText: $("progressText"),
    restartBtn: $("restartBtn"), playPauseBtn: $("playPauseBtn"), stopBtn: $("stopBtn"),
    backBtn: $("backBtn"), forwardBtn: $("forwardBtn"), playbackMessage: $("playbackMessage"),
    textContent: $("textContent"), toggleTextBtn: $("toggleTextBtn")
  };

  const STORAGE_KEY = "txtTtsPlayer_v1";
  const CHUNK_SIZE = 180;
  // Approximate speaking rate used only to estimate 30-second text skips.
  const CHARS_PER_SECOND_AT_1X = 7.0;

  let text = "";
  let fileName = "";
  let sentences = [];
  let currentIndex = 0;
  let currentChar = 0;
  let isPlaying = false;
  let isPaused = false;
  let activeUtterance = null;
  let speechToken = 0;
  let sentenceElements = [];
  let voices = [];
  let currentObjectUrl = null;
  let seekPending = false;

  function supported() {
    return "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
  }

  function setMessage(message) { els.playbackMessage.textContent = message; }

  function saveState() {
    if (!text) return;
    const data = {
      fileName,
      textHash: hashText(text),
      currentIndex,
      currentChar,
      rate: Number(els.rateSelect.value),
      savedAt: Date.now()
    };
    try {
      const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      all[`${fileName}::${data.textHash}`] = data;
      all.lastKey = `${fileName}::${data.textHash}`;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
      els.savedStatus.textContent = `읽기 위치 저장됨 · ${Math.round(progressPercent())}%`;
    } catch (e) {
      els.savedStatus.textContent = "저장 공간에 접근할 수 없습니다. 위치가 보존되지 않을 수 있습니다.";
    }
  }

  function getSavedState() {
    try {
      const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      const key = `${fileName}::${hashText(text)}`;
      return all[key] || null;
    } catch (_) { return null; }
  }

  function hashText(value) {
    // Compact deterministic hash for identifying the same local text file content.
    let h1 = 0xdeadbeef ^ value.length, h2 = 0x41c6ce57 ^ value.length;
    for (let i = 0; i < value.length; i++) {
      const ch = value.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  function splitSentences(value) {
    // Split at sentence punctuation and line breaks; preserve the original characters.
    const parts = value.match(/[^.!?。！？\n]+[.!?。！？]*|\n+/g) || [];
    const out = [];
    for (const part of parts) {
      if (!part) continue;
      if (part.length <= CHUNK_SIZE) out.push(part);
      else {
        // Split exceptionally long paragraphs into smaller pieces, preferring spaces.
        let remaining = part;
        while (remaining.length > CHUNK_SIZE) {
          let cut = remaining.lastIndexOf(" ", CHUNK_SIZE);
          if (cut < Math.floor(CHUNK_SIZE * 0.55)) cut = CHUNK_SIZE;
          out.push(remaining.slice(0, cut));
          remaining = remaining.slice(cut);
        }
        if (remaining) out.push(remaining);
      }
    }
    return out.length ? out : [value];
  }

  function buildTextView() {
    els.textContent.replaceChildren();
    sentenceElements = [];
    const fragment = document.createDocumentFragment();
    sentences.forEach((sentence, index) => {
      const span = document.createElement("span");
      span.className = "sentence";
      span.textContent = sentence;
      span.dataset.index = String(index);
      fragment.appendChild(span);
      sentenceElements.push(span);
    });
    els.textContent.appendChild(fragment);
    highlightCurrent();
  }

  function highlightCurrent() {
    sentenceElements.forEach((el, index) => el.classList.toggle("active", index === currentIndex));
    const active = sentenceElements[currentIndex];
    if (active && !els.textContent.classList.contains("collapsed")) {
      active.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  function progressPercent() {
    if (!sentences.length) return 0;
    let before = 0;
    for (let i = 0; i < Math.min(currentIndex, sentences.length); i++) before += sentences[i].length;
    before += Math.min(currentChar, (sentences[currentIndex] || "").length);
    return Math.max(0, Math.min(100, before / Math.max(1, text.length) * 100));
  }

  function updateProgressUI() {
    const percent = progressPercent();
    els.seekBar.value = String(Math.round(percent * 10));
    els.currentTime.textContent = `${Math.round(percent)}%`;
    els.totalTime.textContent = "100%";
    els.progressText.textContent = sentences.length ? `${Math.min(currentIndex + 1, sentences.length)} / ${sentences.length} 문장` : "읽기 전";
    highlightCurrent();
  }

  function updateButtons() {
    const hasText = Boolean(text.trim());
    [els.playPauseBtn, els.stopBtn, els.restartBtn, els.backBtn, els.forwardBtn, els.seekBar].forEach(el => el.disabled = !hasText);
    els.playPauseBtn.textContent = isPlaying && !isPaused ? "Ⅱ 일시정지" : "▶ 재생";
  }

  function populateVoices() {
    if (!supported()) {
      els.voiceSelect.innerHTML = '<option value="">이 브라우저는 음성 합성을 지원하지 않습니다.</option>';
      setMessage("이 브라우저에서는 음성 합성을 사용할 수 없습니다. 최신 Safari 또는 Chrome을 이용해 주세요.");
      return;
    }
    voices = window.speechSynthesis.getVoices();
    const selected = els.voiceSelect.value;
    els.voiceSelect.replaceChildren();
    const defaultOption = document.createElement("option");
    defaultOption.value = "";
    defaultOption.textContent = "기본 음성";
    els.voiceSelect.appendChild(defaultOption);
    const koVoices = voices.filter(v => /^ko(?:-|$)/i.test(v.lang));
    const shown = koVoices.length ? koVoices : voices;
    shown.forEach((voice) => {
      const option = document.createElement("option");
      option.value = voice.voiceURI;
      option.textContent = `${voice.name} (${voice.lang})${voice.default ? " · 기본" : ""}`;
      els.voiceSelect.appendChild(option);
    });
    if (shown.some(v => v.voiceURI === selected)) els.voiceSelect.value = selected;
    if (!koVoices.length) setMessage("한국어 음성을 찾지 못했습니다. 기기 설정에서 한국어 음성을 설치하거나 기본 음성을 확인해 주세요.");
  }

  function selectedVoice() {
    const uri = els.voiceSelect.value;
    return voices.find(v => v.voiceURI === uri) || null;
  }

  function cancelSpeech() {
    speechToken++;
    if (supported()) window.speechSynthesis.cancel();
    activeUtterance = null;
  }

  function speakCurrent() {
    if (!supported() || !text || currentIndex >= sentences.length) {
      isPlaying = false; isPaused = false; updateButtons();
      if (text) setMessage("끝까지 읽었습니다.");
      return;
    }
    cancelSpeech();
    const token = speechToken;
    const startChar = currentChar;
    const piece = sentences[currentIndex].slice(startChar);
    if (!piece.trim()) {
      currentIndex++; currentChar = 0; updateProgressUI(); saveState(); speakCurrent(); return;
    }
    const utterance = new SpeechSynthesisUtterance(piece);
    utterance.rate = Number(els.rateSelect.value) || 1;
    utterance.lang = selectedVoice()?.lang || "ko-KR";
    const voice = selectedVoice();
    if (voice) utterance.voice = voice;
    activeUtterance = utterance;
    isPlaying = true;
    isPaused = false;
    updateButtons();
    setMessage("읽는 중…");
    utterance.onboundary = (event) => {
      if (token !== speechToken) return;
      if (typeof event.charIndex === "number") {
        currentChar = Math.max(startChar, Math.min(sentences[currentIndex].length, startChar + event.charIndex));
        updateProgressUI();
      }
    };
    utterance.onend = () => {
      if (token !== speechToken) return;
      currentIndex++;
      currentChar = 0;
      if (currentIndex >= sentences.length) {
        isPlaying = false; isPaused = false;
        currentIndex = sentences.length - 1;
        currentChar = sentences[currentIndex]?.length || 0;
        updateProgressUI(); saveState(); updateButtons();
        setMessage("끝까지 읽었습니다.");
        return;
      }
      updateProgressUI();
      saveState();
      speakNextWithoutCancel();
    };
    utterance.onerror = (event) => {
      if (token !== speechToken || event.error === "canceled" || event.error === "interrupted") return;
      isPlaying = false; isPaused = false; updateButtons();
      setMessage(`음성 재생 오류: ${event.error || "알 수 없는 오류"}. 재생 버튼을 다시 눌러 주세요.`);
      saveState();
    };
    try { window.speechSynthesis.speak(utterance); }
    catch (e) {
      isPlaying = false; updateButtons();
      setMessage("음성 재생을 시작하지 못했습니다. 재생 버튼을 다시 눌러 주세요.");
    }
  }

  function speakNextWithoutCancel() {
    if (!text || currentIndex >= sentences.length) return;
    // speakCurrent invalidates the prior token; the previous utterance has ended.
    speakCurrent();
  }

  function play() {
    if (!text) { setMessage("먼저 TXT 파일을 불러오세요."); return; }
    if (!supported()) { setMessage("이 브라우저는 음성 합성을 지원하지 않습니다."); return; }
    if (isPlaying && isPaused) {
      isPaused = false;
      try { window.speechSynthesis.resume(); } catch (_) {}
      updateButtons(); setMessage("이어 읽는 중…"); return;
    }
    if (isPlaying && !isPaused) {
      try { window.speechSynthesis.pause(); } catch (_) {}
      isPaused = true;
      saveState(); updateButtons(); setMessage("일시정지했습니다."); return;
    }
    if (currentIndex >= sentences.length - 1 && currentChar >= (sentences[currentIndex] || "").length) {
      currentIndex = 0; currentChar = 0;
    }
    speakCurrent();
  }

  function stop() {
    cancelSpeech();
    isPlaying = false; isPaused = false;
    saveState(); updateButtons();
    setMessage("정지했습니다. 재생을 누르면 저장된 위치에서 시작합니다.");
  }

  function seekToPercent(percent) {
    if (!text) return;
    const target = Math.max(0, Math.min(100, percent)) / 100 * text.length;
    let sum = 0, index = 0;
    for (; index < sentences.length; index++) {
      if (sum + sentences[index].length >= target) break;
      sum += sentences[index].length;
    }
    currentIndex = Math.min(index, sentences.length - 1);
    currentChar = Math.max(0, Math.min(sentences[currentIndex].length, Math.round(target - sum)));
    // Starting mid-sentence is best-effort; boundary behavior differs by browser.
    if (currentChar > 0 && !sentences[currentIndex].slice(0, currentChar).trim()) currentChar = 0;
    cancelSpeech();
    isPlaying = false; isPaused = false;
    updateProgressUI(); saveState(); updateButtons();
    setMessage("위치를 이동했습니다. 재생을 누르면 여기서부터 읽습니다.");
  }

  function skipSeconds(seconds) {
    if (!text) return;
    const approxChars = seconds * CHARS_PER_SECOND_AT_1X * (Number(els.rateSelect.value) || 1);
    let absolute = 0;
    for (let i = 0; i < currentIndex; i++) absolute += sentences[i].length;
    absolute += currentChar;
    seekToPercent((absolute + approxChars) / Math.max(1, text.length) * 100);
  }

  async function loadFile(file) {
    if (!file) return;
    try {
      const content = await file.text();
      if (!content.trim()) { setMessage("파일에 읽을 텍스트가 없습니다."); return; }
      cancelSpeech();
      text = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
      fileName = file.name;
      sentences = splitSentences(text);
      currentIndex = 0; currentChar = 0;
      els.fileName.textContent = fileName;
      els.fileInfo.textContent = `${text.length.toLocaleString()}자 · ${sentences.length.toLocaleString()}개 읽기 단위`;
      buildTextView();
      const saved = getSavedState();
      if (saved) {
        currentIndex = Math.max(0, Math.min(sentences.length - 1, Number(saved.currentIndex) || 0));
        currentChar = Math.max(0, Math.min((sentences[currentIndex] || "").length, Number(saved.currentChar) || 0));
        if (saved.rate) els.rateSelect.value = String(saved.rate);
        els.savedStatus.textContent = `이전 위치를 찾았습니다 · ${Math.round(progressPercent())}%`;
        setMessage("이전에 읽던 위치를 복원했습니다. 이어 듣기를 누르세요.");
      } else {
        els.savedStatus.textContent = "새 교재입니다. 읽기 위치가 자동 저장됩니다.";
        setMessage("파일을 불러왔습니다. 재생을 누르세요.");
      }
      updateProgressUI(); updateButtons(); saveState();
    } catch (e) {
      setMessage("파일을 읽지 못했습니다. TXT 파일인지 확인해 주세요.");
    }
  }

  els.fileInput.addEventListener("change", (e) => loadFile(e.target.files?.[0]));
  els.playPauseBtn.addEventListener("click", play);
  els.stopBtn.addEventListener("click", stop);
  els.restartBtn.addEventListener("click", () => {
    cancelSpeech(); currentIndex = 0; currentChar = 0; isPlaying = false; isPaused = false;
    updateProgressUI(); saveState(); updateButtons(); setMessage("처음 위치로 이동했습니다. 재생을 누르세요.");
  });
  els.backBtn.addEventListener("click", () => skipSeconds(-30));
  els.forwardBtn.addEventListener("click", () => skipSeconds(30));
  els.seekBar.addEventListener("input", () => {
    if (!text) return;
    seekPending = true;
    const p = Number(els.seekBar.value) / 10;
    els.currentTime.textContent = `${Math.round(p)}%`;
    els.progressText.textContent = "이동할 위치 선택 중";
  });
  els.seekBar.addEventListener("change", () => {
    if (!text) return;
    seekToPercent(Number(els.seekBar.value) / 10);
    seekPending = false;
  });
  els.rateSelect.addEventListener("change", () => {
    saveState();
    if (isPlaying && !isPaused) {
      // Restart current unit at its last known approximate character position.
      speakCurrent();
    }
  });
  els.voiceSelect.addEventListener("change", () => {
    if (isPlaying && !isPaused) speakCurrent();
  });
  els.refreshVoices.addEventListener("click", populateVoices);
  els.clearProgress.addEventListener("click", () => {
    if (!text) { setMessage("먼저 TXT 파일을 불러오세요."); return; }
    cancelSpeech(); currentIndex = 0; currentChar = 0; isPlaying = false; isPaused = false;
    try {
      const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      delete all[`${fileName}::${hashText(text)}`];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    } catch (_) {}
    updateProgressUI(); updateButtons();
    els.savedStatus.textContent = "읽기 위치를 초기화했습니다.";
    setMessage("처음 위치로 초기화했습니다.");
  });
  els.toggleTextBtn.addEventListener("click", () => {
    const collapsed = els.textContent.classList.toggle("collapsed");
    els.toggleTextBtn.textContent = collapsed ? "텍스트 펼치기" : "텍스트 접기";
  });
  window.addEventListener("beforeunload", saveState);
  document.addEventListener("visibilitychange", () => { if (document.hidden) saveState(); });

  if (supported()) {
    populateVoices();
    window.speechSynthesis.onvoiceschanged = populateVoices;
  } else {
    updateButtons();
    setMessage("이 브라우저는 음성 합성을 지원하지 않습니다. 최신 iOS Safari 또는 PC Chrome/Edge를 이용해 주세요.");
  }
  updateButtons();
})();
