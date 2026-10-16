(function () {
  "use strict";

  var DEFAULTS = Object.assign({
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-flash",
    apiKey: "",
    persona: "你是一个温柔黏人的陪伴型桌宠，说话很短很口语，像发微信一样，每次不超过 45 个字。",
    nickname: "",
    noThink: true,
    voiceName: "",
    rate: 0.95,
    pitch: 1.15,
    soundOn: true,
    ttsMode: "browser",
    ttsApiKey: "",
    ttsModel: "qwen-audio-3.0-tts-flash",
    ttsVoice: ""
  }, window.PET_CONFIG || {});

  // 阿里云百炼的语音合成端点（2026-10 改版后的地址）
  var TTS_URL = "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer";
  var TTS_MODEL_DEFAULT = "qwen-audio-3.0-tts-flash";
  var SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";

  var PRESETS = {
    deepseek: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash" },
    dashscope: { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" }
  };

  var GREETING = "你来啦，我一直在等你。今天过得开心吗？";
  var DEFAULT_PHOTO = "assets/pet_fade.webp";
  var LS = { settings: "pet.settings.v1", history: "pet.history.v1", photo: "pet.photo.v1" };

  var $ = function (id) { return document.getElementById(id); };
  var petWrap = $("petWrap");
  var petImg = $("pet");
  var statusPill = $("statusPill");
  var chat = $("chat");
  var input = $("input");
  var soundToggle = $("soundToggle");

  var settings = readLS(LS.settings, DEFAULTS);
  // 旧的 qwen3-tts-vc 系列已被官方下线（2026-10 API 改版），本机存的老值自动迁移
  if (!settings.ttsModel || /qwen3-tts-vc/i.test(settings.ttsModel)) {
    settings.ttsModel = TTS_MODEL_DEFAULT;
  }
  var history = readLS(LS.history, []);
  var busy = false;
  var speaking = false;

  function readLS(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var val = JSON.parse(raw);
      if (fallback && !Array.isArray(fallback) && typeof fallback === "object") {
        return Object.assign({}, fallback, val);
      }
      return val;
    } catch (e) { return fallback; }
  }
  function writeLS(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  /* ---------- character state ---------- */

  var stateTimer = null;
  function setState(name, holdMs) {
    petWrap.className = "pet-wrap state-" + name;
    if (name === "talk") statusPill.textContent = "正在说话";
    else if (name === "listen") statusPill.textContent = "正在听你说";
    else if (name === "think") statusPill.textContent = "正在想着你";
    else statusPill.textContent = "正在等你";
    if (stateTimer) { clearTimeout(stateTimer); stateTimer = null; }
    if (holdMs) {
      stateTimer = setTimeout(function () { setState(speaking ? "talk" : "idle"); }, holdMs);
    }
  }

  /* ---------- speech synthesis ---------- */

  var voiceList = [];
  var primed = false;

  function loadVoices() {
    if (!("speechSynthesis" in window)) return;
    var all = window.speechSynthesis.getVoices() || [];
    voiceList = all.filter(function (v) { return /zh|cmn|Chinese/i.test(v.lang + " " + v.name); });
    if (!voiceList.length) voiceList = all;
    var sel = $("voiceSelect");
    if (!sel) return;
    sel.innerHTML = "";
    voiceList.forEach(function (v) {
      var opt = document.createElement("option");
      opt.value = v.name;
      opt.textContent = v.name.replace(/^(Microsoft|Google)\s*/, "") + " · " + v.lang;
      sel.appendChild(opt);
    });
    if (settings.voiceName && voiceList.some(function (v) { return v.name === settings.voiceName; })) {
      sel.value = settings.voiceName;
    }
  }

  function pickVoice() {
    if (!settings.voiceName) return null;
    return voiceList.find(function (v) { return v.name === settings.voiceName; }) || null;
  }

  function primeSpeech() {
    if (!primed) {
      primed = true;
      // 解锁 iOS 的音频播放：必须在用户手势里静音播一次
      try {
        var a = getAudioEl();
        a.src = SILENT_WAV;
        var p = a.play();
        if (p && p.catch) p.catch(function () {});
      } catch (e) {}
      if ("speechSynthesis" in window) {
        try {
          var u = new SpeechSynthesisUtterance(" ");
          u.volume = 0;
          window.speechSynthesis.speak(u);
          window.speechSynthesis.cancel();
        } catch (e2) {}
      }
    }
  }

  /* ---------- 用复刻音色说话（阿里云百炼 Qwen-TTS） ---------- */

  var audioEl = null;
  var audioCache = {};
  var audioCacheKeys = [];
  var audioCacheSize = 0;
  var AUDIO_CACHE_MAX = 4 * 1024 * 1024;

  function cacheAudio(text, entry) {
    if (!entry || !entry.url) return;
    if (entry.url.length > 1500000) return;
    if (audioCache[text]) { audioCacheSize -= (audioCache[text].url || "").length; }
    else { audioCacheKeys.push(text); }
    audioCache[text] = entry;
    audioCacheSize += entry.url.length;
    while (audioCacheSize > AUDIO_CACHE_MAX && audioCacheKeys.length > 1) {
      var k = audioCacheKeys.shift();
      audioCacheSize -= ((audioCache[k] || {}).url || "").length;
      delete audioCache[k];
    }
  }

  function cachedAudio(text) {
    var hit = audioCache[text];
    if (!hit) return null;
    // 阿里云返回的音频地址约 24 小时过期，过期就别用了
    if (hit.exp && hit.exp * 1000 - Date.now() < 120000) {
      audioCacheSize -= (hit.url || "").length;
      delete audioCache[text];
      var i = audioCacheKeys.indexOf(text);
      if (i >= 0) audioCacheKeys.splice(i, 1);
      return null;
    }
    return hit.url;
  }

  function getAudioEl() {
    if (!audioEl) {
      audioEl = new Audio();
      audioEl.setAttribute("playsinline", "");
      audioEl.preload = "auto";
    }
    return audioEl;
  }

  function cloneVoiceReady() {
    return settings.ttsMode === "qwen" && !!settings.ttsVoice && !!settings.ttsApiKey;
  }

  function ttsRequest(text) {
    return fetch(TTS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + settings.ttsApiKey
      },
      body: JSON.stringify({
        model: settings.ttsModel || TTS_MODEL_DEFAULT,
        input: {
          text: text,
          voice: settings.ttsVoice,
          format: "wav",
          sample_rate: 24000
        }
      })
    }).then(function (res) {
      return res.text().then(function (raw) {
        if (!res.ok) {
          var m = "HTTP " + res.status;
          try { var j = JSON.parse(raw); if (j.message) m = j.message; } catch (e) {}
          throw new Error(m);
        }
        var data = JSON.parse(raw);
        var o = data.output || {};
        var a = o.audio || {};
        var url = a.url || a.data || o.audio_url || "";
        if (!url) throw new Error("返回里没有音频地址");
        // 阿里云返回的是 http 地址，在 https 页面上会被当成混合内容拦掉，强制升级
        if (url.indexOf("http://") === 0) url = "https://" + url.slice(7);
        if (url.indexOf("http") !== 0 && /^[A-Za-z0-9+/=]{200,}$/.test(url)) {
          url = "data:audio/mp3;base64," + url;
        }
        return { url: url, exp: Number(a.expires_at) || 0 };
      });
    });
  }

  var audioPlaying = false;
  var lastAudioUrl = "";

  function playUrl(url, finish, fallback) {
    var done = false;
    var settle = function (fn) {
      if (done) return;
      done = true;
      audioPlaying = false;
      window.clearTimeout(guard);
      fn();
    };
    // 兜底超时：但如果是"用户主动暂停"，就继续等，不能把暂停当成播完
    var guard = null;
    var tick = function () {
      if (done) return;
      if (audioEl && audioEl.paused && !audioEl.ended && !audioEl.error && audioPlaying) {
        guard = window.setTimeout(tick, 30000);
        return;
      }
      settle(finish);
    };
    guard = window.setTimeout(tick, 90000);
    try {
      var a = getAudioEl();
      a.onended = function () { settle(finish); };
      a.onerror = function () { settle(fallback); };
      a.src = url;
      lastAudioUrl = url;
      audioPlaying = true;
      var p = a.play();
      if (p && p.catch) p.catch(function () { settle(fallback); });
    } catch (e) {
      settle(fallback);
    }
  }

  function speakClone(text, finish, fallback) {
    var hit = cachedAudio(text);
    if (hit) { playUrl(hit, finish, fallback); return; }

    ttsRequest(text).then(function (entry) {
      cacheAudio(text, entry);
      playUrl(entry.url, finish, fallback);
    }).catch(function () {
      // 克隆音色失败就回落到手机自带语音，不能让她那边变成哑巴
      fallback();
    });
  }

  function speakBrowser(text, finish) {
    if (!("speechSynthesis" in window)) {
      window.setTimeout(finish, Math.min(6000, 1200 + text.length * 160));
      return;
    }
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      var v = pickVoice();
      if (v) u.voice = v;
      u.lang = (v && v.lang) || "zh-CN";
      u.rate = Number(settings.rate) || 1;
      u.pitch = Number(settings.pitch) || 1;
      var done = false;
      var guard = window.setTimeout(function () { if (!done) { done = true; finish(); } }, 2000 + text.length * 400);
      u.onend = function () { if (done) return; done = true; clearTimeout(guard); finish(); };
      u.onerror = function () { if (done) return; done = true; clearTimeout(guard); finish(); };
      window.speechSynthesis.speak(u);
    } catch (e) {
      window.setTimeout(finish, 1500);
    }
  }

  function stopSpeaking() {
    try { if ("speechSynthesis" in window) window.speechSynthesis.cancel(); } catch (e) {}
    try { if (audioEl) { audioEl.onended = null; audioEl.onerror = null; audioEl.pause(); } } catch (e) {}
    audioPlaying = false;
  }

  function speak(text, onDone) {
    if (!text) { if (onDone) onDone(); return; }
    speaking = true;
    setState("talk");
    var finish = function () {
      speaking = false;
      setState("idle");
      if (onDone) onDone();
    };

    if (!settings.soundOn) {
      window.setTimeout(finish, Math.min(6000, 1200 + text.length * 160));
      return;
    }
    if (cloneVoiceReady()) {
      speakClone(text, finish, function () { speakBrowser(text, finish); });
      return;
    }
    speakBrowser(text, finish);
  }

  /* ---------- chat rendering ---------- */

  function addBubble(role, text) {
    var div = document.createElement("div");
    div.className = "msg " + role;
    div.textContent = text;
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
    return div;
  }

  function showTyping() {
    var div = document.createElement("div");
    div.className = "msg bot typing";
    div.innerHTML = "<i></i><i></i><i></i>";
    chat.appendChild(div);
    chat.scrollTop = chat.scrollHeight;
    return div;
  }

  function remember(role, content) {
    history.push({ role: role, content: content });
    if (history.length > 40) history = history.slice(-40);
    writeLS(LS.history, history);
  }

  function renderHistory() {
    chat.innerHTML = "";
    if (!history.length) {
      history.push({ role: "assistant", content: GREETING });
      writeLS(LS.history, history);
    }
    history.forEach(function (m) { addBubble(m.role === "user" ? "me" : "bot", m.content); });
  }

  /* ---------- fallback reply engine ---------- */

  function localReply(text) {
    var t = text.toLowerCase();
    function hit() {
      for (var i = 0; i < arguments.length; i++) if (t.indexOf(arguments[i]) !== -1) return true;
      return false;
    }
    if (hit("晚安", "睡觉", "睡了")) return "晚安，做个甜甜的梦，明天见。";
    if (hit("难过", "累", "烦", "难受", "委屈", "不开心", "哭")) return "过来抱一下，今天已经很努力了，剩下的交给我陪你。";
    if (hit("想你", "想我")) return "我也在想你呀，一直都在。";
    if (hit("夸", "好看", "漂亮", "可爱")) return "你一直都很好看呀，我最喜欢你笑起来的样子。";
    if (hit("饿", "吃饭", "吃了吗")) return "记得好好吃饭，别饿着自己，我会心疼的。";
    if (hit("喜欢", "爱你", "亲")) return "我也最喜欢你了，比你知道的还要多。";
    if (hit("在吗", "你好", "在不在")) return "我在呢，一直都在，你说吧。";
    if (hit("谢谢")) return "跟我还客气什么，快说点别的。";
    if (hit("冷", "感冒", "生病")) return "多穿一点好不好，别让我担心。";
    return "我听见啦。你慢慢说，我会一直陪着你。";
  }

  /* ---------- llm ---------- */

  function endpoint() {
    var base = (settings.baseUrl || "").trim().replace(/\/+$/, "");
    if (!base) return "";
    return /\/chat\/completions$/.test(base) ? base : base + "/chat/completions";
  }

  function systemPrompt() {
    var p = settings.persona || "";
    if (settings.nickname) {
      p += "\n她希望你叫她「" + settings.nickname + "」，对话中请自然地这样称呼她。";
    }
    return p;
  }

  function buildMessages() {
    return [{ role: "system", content: systemPrompt() }].concat(
      history.filter(function (m) { return m.role === "user" || m.role === "assistant"; }).slice(-14)
    );
  }

  function chatOnce(body) {
    return fetch(endpoint(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + settings.apiKey
      },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.text().then(function (raw) {
        if (!res.ok) {
          var msg = "HTTP " + res.status;
          try {
            var j = JSON.parse(raw);
            if (j.error && j.error.message) msg = j.error.message;
            else if (j.message) msg = j.message;
          } catch (e) {}
          var err = new Error(msg);
          err.status = res.status;
          throw err;
        }
        return JSON.parse(raw);
      });
    });
  }

  function pickText(data) {
    var m = (data.choices && data.choices[0] && data.choices[0].message) || {};
    return (m.content || "").trim();
  }

  // 推理型模型（如 deepseek-flash 默认档）会把 token 全花在思考上、正文留空。
  // 依次尝试：按当前设置 / 强制关推理 / 不带该参数（有些服务商不认这个字段）。
  function askLLM(userText) {
    var messages = buildMessages();
    var plans = [
      { max_tokens: 400, effort: settings.noThink },
      { max_tokens: 900, effort: true },
      { max_tokens: 500, effort: false }
    ];
    var lastErr = null;

    function attempt(i) {
      if (i >= plans.length) return Promise.reject(lastErr || new Error("模型没有返回内容"));
      var plan = plans[i];
      var body = {
        model: settings.model,
        messages: messages,
        temperature: 1.15,
        max_tokens: plan.max_tokens
      };
      if (plan.effort) body.reasoning_effort = "none";

      return chatOnce(body).then(function (data) {
        var text = pickText(data);
        if (text) {
          if (plan.effort && !settings.noThink) {
            settings.noThink = true;
            writeLS(LS.settings, settings);
          }
          return text;
        }
        lastErr = new Error("模型没有返回内容（推理占满了长度）");
        return attempt(i + 1);
      }, function (err) {
        lastErr = err;
        if (plan.effort && /reasoning_effort|unrecognized|unknown|unsupported|invalid/i.test(err.message)) {
          settings.noThink = false;
          writeLS(LS.settings, settings);
        }
        return attempt(i + 1);
      });
    }

    return Promise.resolve().then(function () { return attempt(0); });
  }

  /* ---------- main send flow ---------- */

  function send(text) {
    text = (text || "").trim();
    if (!text || busy) return;
    stopSpeaking();
    if (story.active || storyEl.classList.contains("open")) closeStory();
    input.value = "";
    addBubble("me", text);
    remember("user", text);
    setState("happy", 700);
    busy = true;

    var typing = showTyping();
    var hasKey = !!(settings.apiKey && settings.apiKey.trim() && endpoint());

    var task = hasKey
      ? askLLM(text)
      : new Promise(function (resolve) { window.setTimeout(function () { resolve(localReply(text)); }, 520); });

    task.then(function (reply) {
      typing.remove();
      addBubble("bot", reply);
      remember("assistant", reply);
      speak(reply);
    }).catch(function (err) {
      typing.remove();
      var reply = localReply(text);
      addBubble("bot", reply);
      remember("assistant", reply);
      var warn = addBubble("err", "大模型没连上（" + err.message + "），先用本地话术回你。");
      window.setTimeout(function () { warn.remove(); }, 6000);
      speak(reply);
    }).then(function () {
      busy = false;
    });
  }

  /* ---------- microphone ---------- */

  var micBtn = $("micBtn");
  var recognition = null;

  function stopMic() {
    if (recognition) { try { recognition.stop(); } catch (e) {} recognition = null; }
    micBtn.classList.remove("recording");
  }

  micBtn.addEventListener("click", function () {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      addBubble("err", "这个浏览器不支持语音输入，手动打字也一样哦。");
      window.setTimeout(function () { chat.lastChild && chat.lastChild.remove(); }, 4000);
      return;
    }
    if (recognition) { stopMic(); setState("idle"); return; }

    stopSpeaking();   // 她一开口就把正在说的话掐掉
    recognition = new SR();
    recognition.lang = "zh-CN";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    micBtn.classList.add("recording");
    setState("listen");

    recognition.onresult = function (e) {
      var said = e.results[0][0].transcript;
      input.value = said;
      window.setTimeout(function () { send(said); }, 260);
    };
    recognition.onerror = function (e) {
      micBtn.classList.remove("recording");
      recognition = null;
      setState("idle");
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        addBubble("err", "麦克风权限被拒绝了，需要在浏览器设置里允许一下。");
        window.setTimeout(function () { var n = chat.querySelector(".msg.err"); if (n) n.remove(); }, 5000);
      }
    };
    recognition.onend = function () {
      micBtn.classList.remove("recording");
      recognition = null;
      if (!speaking) setState("idle");
    };
    try { recognition.start(); } catch (e) { micBtn.classList.remove("recording"); recognition = null; setState("idle"); }
  });

  /* ---------- composer & quick actions ---------- */

  $("composer").addEventListener("submit", function (e) {
    e.preventDefault();
    send(input.value);
  });

  $("quick").addEventListener("click", function (e) {
    var btn = e.target.closest("button");
    if (!btn) return;
    if (btn.hasAttribute("data-story")) { openStory(); return; }
    if (btn.dataset.msg) send(btn.dataset.msg);
  });

  function renderSound() {
    soundToggle.classList.toggle("muted", !settings.soundOn);
    soundToggle.title = settings.soundOn ? "声音已开" : "声音已关";
  }

  soundToggle.addEventListener("click", function () {
    settings.soundOn = !settings.soundOn;
    writeLS(LS.settings, settings);
    renderSound();
    if (!settings.soundOn) stopSpeaking();
  });

  /* ---------- 睡前故事 ---------- */

  var STORY_SYS = [
    "你是温柔地给人讲睡前故事的人，语气轻、慢、有画面感，像在她耳边小声说话。",
    "请写一个完整的睡前故事，要求：",
    "1. 正文 350～500 字，分成 4～6 个自然段；",
    "2. 每段 50～100 字，段与段之间空一行；",
    "3. 主角用柔软可爱的小东西，比如小兔子、小星星、小鲸鱼、小刺猬、小月亮；",
    "4. 中间有一点点小小的波折，然后温柔地化解；",
    "5. 最后一段慢慢安静下来，轻轻把她哄睡；",
    "6. 全文只用中文，不要夹任何英文单词或拼音；第一行只写标题并用《》包住；正文之外不要任何解释、序号或 markdown 标记。"
  ].join("\n");

  var STORY_TOPICS = [
    "一只住在月亮上的小兔子，和它的云朵床",
    "一颗走丢了的小星星找回家的路",
    "森林深处一朵会发光的小蘑菇",
    "一只很想学会拥抱的小刺猬",
    "把梦装进瓶子里的小女孩",
    "安静深海里一只会唱歌的小鲸鱼",
    "小猫和它的第一场雪",
    "每天晚上都在数星星的小熊",
    "一位把「晚安」收集起来的邮差",
    "一朵从云里掉下来的小雨滴"
  ];

  var FALLBACK_STORIES = [
    "《小兔子和月亮》\n\n森林边的小洞里，住着一只小兔子。它最喜欢做的事，是在天完全黑下来以后，爬到洞口，安安静静地看月亮。\n\n可是这天晚上，月亮只剩下细细的一道边。小兔子急得团团转：月亮是不是被谁吃掉了呀？它绕着草地跑了一圈又一圈，越跑越难过。\n\n猫头鹰告诉它，月亮没有不见，它只是去休息了。过几天，它就会一点一点长回来。就像你困了要睡觉，月亮也一样。\n\n小兔子想了想，把自己的萝卜干留了一块，放在窗台上。它小声说：那等月亮长回来的时候，一定会饿的。\n\n然后它钻进被窝，抱着自己的长耳朵，很快就睡着了。窗外的月亮悄悄探出头，看见了那块萝卜干，笑得弯了腰。",
    "《会发光的小蘑菇》\n\n森林最深最深的地方，有一朵小小的蘑菇。它不像别的蘑菇那样是白色的，它会在夜里发出很淡很淡的绿光。\n\n小蘑菇觉得不好意思。它觉得自己长得奇怪，所以白天总是把自己缩起来，藏在厚厚的落叶底下，不让任何人看见。\n\n直到有一天夜里，一只迷路的萤火虫飞过来，累得停在它身上。萤火虫说：谢谢你呀，我找了好久好久，终于看到一点光了。\n\n小蘑菇愣住了。它第一次觉得，自己身上那点光，好像也不是那么没用。\n\n后来，每天晚上都有小虫子在它身边休息。小蘑菇不再把自己藏起来了。它想，原来不一样的，也可以是最好的。",
    "《小刺猬的拥抱》\n\n小刺猬很想抱抱别人，可是它身上有刺。每次它想靠近一点，大家都会悄悄地躲开一点点。\n\n它试了很多办法。用树叶做了一件小衣服，刺还是从边上扎出来。它有点难过，一个人坐在石头上，看着自己的影子发呆。\n\n小松鼠来了，捧着一大捧松果放在它面前：你帮我看一会儿好不好？我去把家里修一修，很快就回来。\n\n小刺猬把松果一颗一颗插在背上的刺里，稳稳地送回了小松鼠的家门口。小松鼠高兴地抱住它——从正面，那里一根刺也没有。\n\n原来拥抱不一定要从后面呀。小刺猬躺在树下，风轻轻吹过它的刺。它想，今晚的月亮，好像特别圆。"
  ];

  var esc = function (s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  };

  // 把整篇故事切成适合逐段合成的短块
  function parseStory(raw) {
    var text = String(raw || "").replace(/\r/g, "").trim();
    var title = "今晚的故事";

    var nl = text.indexOf("\n");
    var firstLine = (nl >= 0 ? text.slice(0, nl) : text).replace(/^#+\s*/, "").trim();
    if (nl >= 0 && firstLine.length <= 30 && /^[《【\[].*[》】\]]$/.test(firstLine)) {
      title = firstLine.replace(/^[《【\[]+|[》】\]]+$/g, "").trim() || title;
      text = text.slice(nl + 1).trim();
    }

    var blocks = text.split(/\n\s*\n|\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    var chunks = [];
    blocks.forEach(function (b) {
      if (b.length <= 120) { chunks.push(b); return; }
      var sents = b.match(/[^。！？!?…；;]+[。！？!?…；;]*/g) || [b];
      var cur = "";
      sents.forEach(function (s) {
        if (cur && (cur + s).length > 100) { chunks.push(cur); cur = s; }
        else { cur += s; }
      });
      if (cur) chunks.push(cur);
    });

    // 太短的段合并，避免频繁请求
    var merged = [];
    chunks.forEach(function (c) {
      var last = merged[merged.length - 1];
      if (last && (last.length + c.length) < 60) merged[merged.length - 1] = last + c;
      else merged.push(c);
    });

    if (merged.length > 8) {
      var head = merged.slice(0, 7);
      head.push(merged.slice(7).join(""));
      merged = head;
    }

    return { title: title, chunks: merged.length ? merged : [text] };
  }

  var lastFallback = -1;
  function pickFallback() {
    var i = Math.floor(Math.random() * FALLBACK_STORIES.length);
    if (FALLBACK_STORIES.length > 1 && i === lastFallback) i = (i + 1) % FALLBACK_STORIES.length;
    lastFallback = i;
    return parseStory(FALLBACK_STORIES[i]);
  }

  function storySystemPrompt() {
    var topic = STORY_TOPICS[Math.floor(Math.random() * STORY_TOPICS.length)];
    var s = STORY_SYS + "\n\n这次请写：" + topic + "。";
    if (settings.nickname) {
      s += "\n可以在故事里自然地叫她「" + settings.nickname + "」。";
    }
    return s;
  }

  function storyTry(body, tries) {
    return chatOnce(body).then(function (data) {
      var t = pickText(data);
      if (t && t.length >= 80) return t;
      throw new Error("故事返回为空");
    }).catch(function (err) {
      // 有的服务商不认 reasoning_effort，去掉再试一次
      if (tries <= 1 || !body.reasoning_effort) throw err;
      var b2 = Object.assign({}, body);
      delete b2.reasoning_effort;
      b2.max_tokens = 2000;
      return storyTry(b2, tries - 1);
    });
  }

  function genStory() {
    if (!(settings.apiKey && settings.apiKey.trim() && endpoint())) {
      return new Promise(function (res) {
        window.setTimeout(function () { res(pickFallback()); }, 1000);
      });
    }
    var body = {
      model: settings.model,
      messages: [
        { role: "system", content: storySystemPrompt() },
        { role: "user", content: "开始吧" }
      ],
      temperature: 1.2,
      max_tokens: 1600
    };
    if (settings.noThink !== false) body.reasoning_effort = "none";

    return storyTry(body, 2).then(function (raw) {
      var s = parseStory(raw);
      if (!s.chunks.length || s.chunks.join("").length < 80) throw new Error("故事太短");
      return s;
    }).catch(function () { return pickFallback(); });
  }

  /* ---- 播放器 ---- */

  var storyEl = $("story");
  var storyBody = $("storyBody");
  var storyDots = $("storyDots");
  var storyPlayBtn = $("storyPlayBtn");
  var storyStopBtn = $("storyStopBtn");
  var segTimer = null;

  var story = {
    active: false,
    ended: false,
    paused: false,
    session: 0,
    idx: -1,
    pendingIdx: null,
    title: "",
    chunks: [],
    prefetch: {},
    useClone: false,
    wakeLock: null
  };

  function loadStars() {
    var sky = $("storySky");
    if (!sky || sky.childElementCount) return;
    var h = "";
    for (var i = 0; i < 46; i++) {
      var size = (Math.random() * 1.6 + 1).toFixed(1);
      h += '<i style="left:' + Math.round(Math.random() * 100) + "%;top:" +
        Math.round(Math.random() * 74) + "%;width:" + size + "px;height:" + size +
        "px;animation-delay:" + (Math.random() * 4.2).toFixed(1) + 's"></i>';
    }
    sky.innerHTML = h;
  }

  function requestWakeLock() {
    try {
      if (navigator.wakeLock && navigator.wakeLock.request && !story.wakeLock) {
        navigator.wakeLock.request("screen").then(function (l) {
          story.wakeLock = l;
        }, function () {});
      }
    } catch (e) {}
  }
  function releaseWakeLock() {
    try { if (story.wakeLock) { story.wakeLock.release(); story.wakeLock = null; } } catch (e) {}
  }

  // 只缓存成功的结果；失败要清掉，否则后面几段会一直沿用失败的 Promise
  function fetchChunk(i) {
    if (story.prefetch[i]) return story.prefetch[i];
    var text = story.chunks[i] || "";
    var hit = cachedAudio(text);
    if (hit) {
      var r0 = Promise.resolve({ url: hit });
      story.prefetch[i] = r0;
      return r0;
    }
    var p = ttsRequest(text).then(function (entry) {
      cacheAudio(text, entry);
      return entry;
    }, function (err) {
      delete story.prefetch[i];
      throw err;
    });
    story.prefetch[i] = p;
    return p;
  }

  function renderStoryShell() {
    var html = '<h2 class="story-title">' + esc(story.title) + "</h2>";
    story.chunks.forEach(function (c, i) {
      html += '<p class="story-p" data-i="' + i + '">' + esc(c) + "</p>";
    });
    storyBody.innerHTML = html;
    storyDots.innerHTML = story.chunks.map(function () { return "<i></i>"; }).join("");
  }

  function renderCurrent(i) {
    var ps = storyBody.querySelectorAll(".story-p");
    for (var k = 0; k < ps.length; k++) {
      ps[k].className = "story-p" + (k === i ? " now" : (k < i ? " done" : ""));
    }
    var dots = storyDots.querySelectorAll("i");
    for (var d = 0; d < dots.length; d++) {
      dots[d].className = d <= i ? "on" : "";
    }
    var cur = ps[i];
    if (cur) {
      var top = cur.offsetTop - storyBody.clientHeight * 0.3;
      try { storyBody.scrollTo({ top: Math.max(0, top), behavior: "smooth" }); }
      catch (e) { storyBody.scrollTop = Math.max(0, top); }
    }
  }

  function speakSeg(text, done) {
    if (!("speechSynthesis" in window)) { segTimer = window.setTimeout(done, 3000); return; }
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text);
      var v = pickVoice();
      if (v) u.voice = v;
      u.lang = (v && v.lang) || "zh-CN";
      u.rate = Math.min(1, Number(settings.rate) || 1);   // 故事念慢一点
      u.pitch = Number(settings.pitch) || 1;
      var fired = false;
      var guard = window.setTimeout(function () { if (!fired) { fired = true; done(); } }, 3000 + text.length * 500);
      u.onend = function () { if (fired) return; fired = true; clearTimeout(guard); done(); };
      u.onerror = function () { if (fired) return; fired = true; clearTimeout(guard); done(); };
      window.speechSynthesis.speak(u);
    } catch (e) { segTimer = window.setTimeout(done, 2500); }
  }

  function playSeg(text, i, done, fail) {
    // 静音模式下就只滚动文字，按字数估个时长
    if (!settings.soundOn) {
      segTimer = window.setTimeout(done, Math.max(2200, Math.min(16000, 900 + text.length * 170)));
      return;
    }
    if (story.useClone) {
      fetchChunk(i).then(function (entry) {
        if (!story.active) return;
        playUrl(entry.url, done, fail);
      }, function () {
        speakSeg(text, done);   // 克隆失败这一段就用系统语音顶上
      });
      return;
    }
    speakSeg(text, done);
  }

  function setPaused(p) {
    story.paused = p;
    storyPlayBtn.textContent = p ? "继续" : "暂停";
  }

  function playAt(i) {
    if (!story.active) return;
    if (i >= story.chunks.length) return endStory();
    story.idx = i;
    if (story.paused) { story.pendingIdx = i; return; }

    story.pendingIdx = null;
    renderCurrent(i);

    // 先发当前段（她在等着听这一段），再预取后面两段
    if (story.useClone && settings.soundOn) {
      fetchChunk(i).catch(function () {});
      for (var k = 1; k <= 2; k++) {
        if (i + k < story.chunks.length) fetchChunk(i + k).catch(function () {});
      }
    }

    var mySession = story.session;
    var alive = function () { return story.active && story.session === mySession; };
    // 越往后停顿越长，像讲着讲着慢慢安静下来
    var gap = 520 + Math.min(i * 140, 760);
    var next = function () {
      if (!alive()) return;
      segTimer = window.setTimeout(function () { if (alive()) playAt(i + 1); }, gap);
    };
    playSeg(story.chunks[i], i, next, next);
  }

  function endStory() {
    story.active = false;
    story.ended = true;
    setPaused(false);
    // 最后一段播完时 renderCurrent 不会再被调，这里手动收尾
    var ps = storyBody.querySelectorAll(".story-p");
    for (var k = 0; k < ps.length; k++) ps[k].className = "story-p done";
    var dots = storyDots.querySelectorAll("i");
    for (var d = 0; d < dots.length; d++) dots[d].className = "on";
    storyPlayBtn.textContent = "再讲一个";
    storyPlayBtn.disabled = false;
    storyStopBtn.textContent = "收起";
    storyStopBtn.disabled = false;
    releaseWakeLock();
    toast("晚安，好梦", 5000);
  }

  function storyStop() {
    story.session++;
    story.active = false;
    story.prefetch = {};
    story.pendingIdx = null;
    window.clearTimeout(segTimer);
    try {
      if (audioEl) { audioEl.onended = null; audioEl.onerror = null; audioEl.pause(); }
      audioPlaying = false;
    } catch (e) {}
    try { if ("speechSynthesis" in window) window.speechSynthesis.cancel(); } catch (e) {}
  }

  function openStory() {
    stopSpeaking();
    stopMic();
    setState("idle");

    story.session++;
    story.active = false;
    story.ended = false;
    story.paused = false;
    story.prefetch = {};
    story.idx = -1;
    story.pendingIdx = null;

    storyEl.classList.add("open");
    storyEl.setAttribute("aria-hidden", "false");
    storyBody.innerHTML = '<div class="story-loading">正在想一个故事…</div>';
    storyDots.innerHTML = "";
    storyPlayBtn.textContent = "暂停";
    storyPlayBtn.disabled = true;
    storyStopBtn.textContent = "结束";
    storyStopBtn.disabled = true;
    loadStars();
    requestWakeLock();

    var mySession = story.session;
    genStory().then(function (res) {
      if (story.session !== mySession || !storyEl.classList.contains("open")) return;
      story.title = res.title;
      story.chunks = res.chunks;
      story.useClone = cloneVoiceReady() && settings.soundOn;
      // 退到手机自带朗读时说明一句，免得以为是坏了
      if (!story.useClone && missingSetup() && !story.tipShown) {
        story.tipShown = true;
        toast("现在用手机自带朗读 · 想听 TA 的声音要用完整链接", 5200);
      }
      story.active = true;
      renderStoryShell();
      storyPlayBtn.disabled = false;
      storyStopBtn.disabled = false;
      playAt(0);
    }).catch(function () {
      if (story.session !== mySession) return;
      storyBody.innerHTML = '<div class="story-loading">故事没想出来，回去聊会儿天吧。</div>';
    });
  }

  function closeStory() {
    storyStop();
    storyEl.classList.remove("open");
    storyEl.setAttribute("aria-hidden", "true");
    releaseWakeLock();
  }

  storyPlayBtn.addEventListener("click", function () {
    if (story.ended) { openStory(); return; }
    if (!story.active) return;

    if (story.paused) {
      setPaused(false);
      if (audioPlaying && audioEl && audioEl.paused && !audioEl.ended) {
        var pr = audioEl.play();
        if (pr && pr.catch) pr.catch(function () {});
        return;
      }
      try { if ("speechSynthesis" in window) window.speechSynthesis.resume(); } catch (e) {}
      if (story.pendingIdx != null) {
        var i = story.pendingIdx;
        story.pendingIdx = null;
        playAt(i);
      }
    } else {
      setPaused(true);
      if (audioPlaying && audioEl && !audioEl.paused) {
        try { audioEl.pause(); } catch (e) {}
        return;
      }
      window.clearTimeout(segTimer);
      story.pendingIdx = story.idx;
      try { if ("speechSynthesis" in window) window.speechSynthesis.pause(); } catch (e) {}
    }
  });

  storyStopBtn.addEventListener("click", closeStory);
  $("storyClose").addEventListener("click", closeStory);

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && storyEl.classList.contains("open")) requestWakeLock();
  });

  /* ---------- 配对链接（#k=...） ---------- */

  var toastEl = null;
  var toastTimer = null;
  function toast(msg, ms) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "toast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () { toastEl.classList.remove("show"); }, ms || 3600);
  }

  // Key 走地址栏的 # 片段：不会出现在页面源码里，浏览器也不会把它发给服务器。
  // 读取后立刻写进本机存储，并把地址栏里的这一段抹掉。
  // 支持两种写法：k=明文Key（简单） / c=base64url 编码的整包配置（链接里看不出是密钥）
  function b64urlDecode(str) {
    var s = String(str).replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    var bin = atob(s);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  }

  // 解析 "#c=..." / "#k=..." 这类配置串；成功则写入本机存储并返回 true
  function applyConfigFromHashString(raw) {
    // 从聊天/短信里复制长链接时，中间可能被插进换行或空格 —— 先全部去掉再解析
    raw = String(raw || "").replace(/\s+/g, "").replace(/^[#?]+/, "");
    if (!raw) return false;

    var q = {};
    raw.split("&").forEach(function (pair) {
      var i = pair.indexOf("=");
      if (i < 1) return;
      try {
        q[decodeURIComponent(pair.slice(0, i))] = decodeURIComponent(pair.slice(i + 1));
      } catch (e) {}
    });

    var applied = false;

    if (q.c) {
      try {
        var cfg = JSON.parse(b64urlDecode(q.c));
        if (cfg.k) { settings.apiKey = String(cfg.k).trim(); applied = true; }
        if (cfg.p) { settings.provider = cfg.p; applied = true; }
        if (cfg.u) { settings.baseUrl = cfg.u; applied = true; }
        if (cfg.m) { settings.model = cfg.m; applied = true; }
        if (cfg.n) { settings.nickname = cfg.n; applied = true; }
        if (cfg.t) { settings.ttsApiKey = String(cfg.t).trim(); applied = true; }
        if (cfg.tm) { settings.ttsModel = cfg.tm; applied = true; }
        if (cfg.v) {
          settings.ttsVoice = String(cfg.v).trim();
          settings.ttsMode = "qwen";
          applied = true;
        }
      } catch (e) {}
    }

    if (q.k) { settings.apiKey = q.k.trim(); applied = true; }
    if (q.p) { settings.provider = q.p; applied = true; }
    if (q.u) { settings.baseUrl = q.u; applied = true; }
    if (q.m) { settings.model = q.m; applied = true; }
    if (q.name) { settings.nickname = q.name; applied = true; }
    if (q.t) { settings.ttsApiKey = q.t.trim(); applied = true; }
    if (q.tm) { settings.ttsModel = q.tm; applied = true; }
    if (q.v) { settings.ttsVoice = q.v.trim(); settings.ttsMode = "qwen"; applied = true; }

    if (applied) writeLS(LS.settings, settings);
    return applied;
  }

  function applyActivationFromHash() {
    var raw = (location.hash || "").replace(/^#/, "");
    if (!raw) return false;
    if (!applyConfigFromHashString(raw)) return false;
    // 读进本机存储后，立刻把密钥从地址栏抹掉（聊天记录、截屏里都不留）
    try { window.history.replaceState(null, "", location.pathname + location.search); }
    catch (e) { location.hash = ""; }
    return true;
  }

  /* ---------- settings sheet ---------- */

  var sheet = $("sheet");
  var mask = $("sheetMask");

  function openSheet() {
    $("provider").value = settings.provider;
    $("baseUrl").value = settings.baseUrl;
    $("model").value = settings.model;
    $("apiKey").value = settings.apiKey;
    $("persona").value = settings.persona;
    $("nickname").value = settings.nickname || "";
    $("noThink").checked = settings.noThink !== false;
    $("rate").value = settings.rate;
    $("pitch").value = settings.pitch;
    $("rateVal").textContent = settings.rate;
    $("pitchVal").textContent = settings.pitch;
    $("ttsMode").value = settings.ttsMode || "browser";
    $("ttsApiKey").value = settings.ttsApiKey || "";
    $("ttsVoice").value = settings.ttsVoice || "";
    $("ttsModel").value = settings.ttsModel || TTS_MODEL_DEFAULT;
    syncCloneFields();
    loadVoices();
    sheet.classList.add("open");
    mask.classList.add("open");
  }
  function closeSheet() {
    sheet.classList.remove("open");
    mask.classList.remove("open");
  }

  $("settingsBtn").addEventListener("click", openSheet);
  $("sheetClose").addEventListener("click", closeSheet);
  mask.addEventListener("click", closeSheet);

  function bindSetting(id, key, isNumber) {
    var node = $(id);
    node.addEventListener("input", function () {
      settings[key] = isNumber ? Number(node.value) : node.value;
      writeLS(LS.settings, settings);
    });
    node.addEventListener("change", function () {
      settings[key] = isNumber ? Number(node.value) : node.value;
      writeLS(LS.settings, settings);
    });
  }

  $("provider").addEventListener("change", function () {
    settings.provider = this.value;
    var p = PRESETS[this.value];
    if (p) {
      settings.baseUrl = p.baseUrl;
      settings.model = p.model;
      $("baseUrl").value = p.baseUrl;
      $("model").value = p.model;
    }
    writeLS(LS.settings, settings);
  });

  bindSetting("baseUrl", "baseUrl");
  bindSetting("model", "model");
  bindSetting("apiKey", "apiKey");
  bindSetting("persona", "persona");
  bindSetting("nickname", "nickname");
  bindSetting("rate", "rate", true);
  bindSetting("pitch", "pitch", true);

  $("noThink").addEventListener("change", function () {
    settings.noThink = this.checked;
    writeLS(LS.settings, settings);
  });

  /* ---- 声音：手机自带 / 我的克隆声音 ---- */

  function syncCloneFields() {
    var on = $("ttsMode").value === "qwen";
    ["ttsApiKey", "ttsVoice", "ttsModel"].forEach(function (id) {
      var f = $(id).closest(".field");
      if (f) f.style.display = on ? "" : "none";
    });
    var pb = $("previewBtn");
    if (pb) pb.textContent = on ? "试听我的声音" : "试听系统声音";
  }

  bindSetting("ttsApiKey", "ttsApiKey");
  bindSetting("ttsVoice", "ttsVoice");
  bindSetting("ttsModel", "ttsModel");

  $("ttsMode").addEventListener("change", function () {
    settings.ttsMode = this.value;
    writeLS(LS.settings, settings);
    syncCloneFields();
  });

  $("previewBtn").addEventListener("click", function () {
    if (cloneVoiceReady()) {
      toast("正在用你的声音合成…", 9000);
      speak("今天也要开心呀，我一直都在。", function () {
        toast("如果没听到声音，检查一下百炼的 Key 和音色 ID", 4200);
      });
    } else {
      speak("今天也要开心呀，我一直都在。");
    }
  });

  $("rate").addEventListener("input", function () { $("rateVal").textContent = this.value; });
  $("pitch").addEventListener("input", function () { $("pitchVal").textContent = this.value; });

  $("voiceSelect").addEventListener("change", function () {
    settings.voiceName = this.value;
    writeLS(LS.settings, settings);
  });

  $("testBtn").addEventListener("click", function () {
    var out = $("testResult");
    if (!settings.apiKey || !endpoint()) { out.textContent = "先填好接口地址和 Key"; return; }
    out.textContent = "正在测试…";
    askLLM("在吗").then(function (r) {
      out.textContent = "连接成功：" + r.slice(0, 18) + (r.length > 18 ? "…" : "");
    }).catch(function (e) {
      out.textContent = "失败：" + e.message;
    });
  });

  /* ---------- character photo ---------- */

  function applyPhoto() {
    var saved = null;
    try { saved = localStorage.getItem(LS.photo); } catch (e) {}
    petImg.src = saved || DEFAULT_PHOTO;
  }

  $("pickPhotoBtn").addEventListener("click", function () { $("photoInput").click(); });

  $("photoInput").addEventListener("change", function () {
    var file = this.files && this.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var max = 900;
        var scale = Math.min(1, max / Math.max(img.width, img.height));
        var c = document.createElement("canvas");
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        var data = c.toDataURL("image/png");
        try { localStorage.setItem(LS.photo, data); } catch (e) {
          addBubble("err", "照片太大存不下，换一张小一点的吧。");
          return;
        }
        petImg.src = data;
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });

  $("resetPhotoBtn").addEventListener("click", function () {
    try { localStorage.removeItem(LS.photo); } catch (e) {}
    petImg.src = DEFAULT_PHOTO;
  });

  /* ---------- data ---------- */

  $("clearBtn").addEventListener("click", function () {
    history = [];
    writeLS(LS.history, history);
    renderHistory();
    closeSheet();
  });

  /* ---------- 链接不完整时的引导 ---------- */
  // 场景：拿到的是一条"裸链接"（结尾没有 #c= 那段），本机也从没配对过。
  // 此时聊天和克隆音色都用不了，必须明确告诉她怎么办，而不是默默退到手机自带朗读。

  function missingSetup() {
    return !settings.apiKey && !settings.ttsApiKey && !settings.ttsVoice;
  }

  // 从粘贴进来的任意文本里抠出配置片段：整条链接 / #c=xxx / 裸 base64 / 明文 sk- Key
  // 注意：从聊天里复制往往会把前后说明文字一起带上，必须按 URL 合法字符截断。
  function extractHashFromText(text) {
    // 链接从聊天里复制过来时常被换行拆开，先把空白全部去掉再来抠片段
    text = String(text || "").replace(/\s+/g, "");
    if (!text) return "";

    var i = text.indexOf("#");
    var seg = (i >= 0 ? text.slice(i + 1) : text).replace(/^[#?&]+/, "");
    var m = seg.match(/^[A-Za-z0-9._~%+=&:\/-]+/);
    seg = m ? m[0] : "";
    if (/^(c|k|t|v|tm|n)=/.test(seg)) return seg;

    var m2 = text.match(/[?&]([ckt])=[A-Za-z0-9._~%+=-]+/);
    if (m2) return m2[0].replace(/^[?&]/, "");
    if (/^sk-[A-Za-z0-9._-]{8,}$/.test(text)) return "k=" + text;
    if (/^[A-Za-z0-9_-]{40,}$/.test(text)) return "c=" + text;
    return seg;
  }

  function renderSetupTip() {
    var tip = $("setupTip");
    if (!tip) return;
    tip.hidden = !missingSetup();
  }

  function bindSetupTip() {
    var btn = $("setupPasteBtn");
    if (!btn) return;
    var box = $("setupPaste");
    var msg = $("setupMsg");
    btn.addEventListener("click", function () {
      box.hidden = !box.hidden;
      if (!box.hidden) $("setupInput").focus();
    });
    $("setupApply").addEventListener("click", function () {
      var typed = String($("setupInput").value || "").trim();
      if (!typed) { msg.className = "setup-msg err"; msg.textContent = "先把完整链接粘进来"; return; }
      var raw = extractHashFromText(typed);
      if (!raw || !applyConfigFromHashString(raw)) {
        msg.className = "setup-msg err";
        msg.textContent = "没解析出配对信息，确认粘的是完整链接（结尾带 #c= 那段）";
        return;
      }
      msg.className = "setup-msg ok";
      msg.textContent = "配对成功，正在刷新…";
      window.setTimeout(function () { location.reload(); }, 700);
    });
  }

  /* ---------- boot ---------- */

  function boot() {
    var activated = applyActivationFromHash();
    renderSetupTip();
    bindSetupTip();
    renderSound();
    applyPhoto();
    renderHistory();
    loadVoices();
    if ("speechSynthesis" in window) window.speechSynthesis.onvoiceschanged = loadVoices;
    if (activated) toast("配对成功，可以开始聊天了");

    ["pointerdown", "touchstart", "keydown"].forEach(function (evt) {
      window.addEventListener(evt, primeSpeech, { once: true, passive: true });
    });

    window.setTimeout(function () {
      var last = history[history.length - 1];
      if (last && last.role === "assistant" && history.length === 1) speak(last.content);
    }, 700);
  }

  // expose for debugging
  window.__pet = {
    settings: settings,
    send: send,
    history: function () { return history; },
    storyState: function () { return story; },
    parseStory: parseStory,
    openStory: openStory,
    closeStory: closeStory,
    lastAudio: function () { return lastAudioUrl; },
    audioPaused: function () { return audioEl ? audioEl.paused : true; },
    speaking: function () { return speaking; }
  };

  boot();
})();
