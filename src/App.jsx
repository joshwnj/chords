import { useState, useEffect, useRef } from "react";
import "./App.css";

import { create } from "zustand";
import { shallow } from "zustand/shallow";
import { persist, createJSONStorage } from "zustand/middleware";

import ClipMeter from "./components/ClipMeter";

import { connectAll, setParams, rand } from "wakit";

import { parse as parseNote } from "./note-parser";
const midiToFreq = (note) => 440 * Math.pow(2, (note - 69) / 12);

function doAttack(
  param,
  { time = ac.currentTime, a = 0.2, s = 0.2, d = 1 } = {},
) {
  const attackTime = a;
  const sustain = s;
  const decayCurve = d;

  param.cancelAndHoldAtTime(time);
  param.exponentialRampToValueAtTime(0.00001, time);

  // attack
  param.linearRampToValueAtTime(1.0, time + attackTime);
  param.attackUntil = time + attackTime;

  // decay + sustain
  param.setTargetAtTime(sustain, time + attackTime, decayCurve);
}

function doRelease(param, { time = ac.currentTime, r = 0.3 } = {}) {
  const releaseCurve = r;

  param.cancelAndHoldAtTime(time);

  if (time < param.attackUntil) {
    param.linearRampToValueAtTime(0.0, time + 0.1);
  } else {
    param.setTargetAtTime(0.0, time, releaseCurve);
  }
}

const useStore = create(
  (set, get) => ({
    isBooted: !!window.ac,

    boot: () => {
      window.ac = new AudioContext();

      set({ isBooted: true });
    },
    
    currentChord: null,
    setCurrentChord(currentChord) {
      set({ currentChord })
    },
    
    currentNotes: [],
    setCurrentNotes (currentNotes) {
      set({ currentNotes })
    },
    
    nextNotes: [],
    setNextNotes (nextNotes) {
      set({ nextNotes })
    },
  }),
  shallow,
);

const useChordStore = create(
  persist(
    (set, get) => ({
      raw: "",
      chords: [],

      addChord(chord) {
        set((state) => ({
          chords: [...state.chords, chord],
        }));
      },

      setRaw(raw) {
        const chords = raw.split("\n").filter(Boolean);
        set({ raw, chords });
      },

      parse(chord) {
        if (!chord) { return [] }
      
        const data = chord.includes("|") ? chord.split("|")[1] : chord;
        const items = data.split(/\s/).filter(Boolean);
        const notes = [];
        let root;
        for (const item of items) {
          if (/^\d+$/.test(item)) {
            notes.push(root + parseInt(item, 10));
          } else {
            try {
              root = parseNote(item).midi;
            } catch (err) {
              console.error('Failed parsing:', { item })
            }
          }
        }
        return notes;
      },
    }),
    {
      name: "chord-storage",
      storage: createJSONStorage(() => localStorage),
    },
  ),
);

const keymap = {};

function onKeyDown(e) {
  const { key } = e;
  const func = keymap[key];

  if (func) {
    func();
  }
}

function Boot({ children }) {
  const [isBooted, boot] = useStore((s) => [s.isBooted, s.boot]);

  useEffect(() => {
    window.addEventListener("keydown", onKeyDown, false);

    return () => {
      window.removeEventListener("keydown", onKeyDown, false);
    };
  }, []);

  return isBooted ? (
    <>{children}</>
  ) : (
    <>
      <div>
        <button onClick={boot}>Start</button>
      </div>
    </>
  );
}

if (!window.nodes) {
  window.nodes = {};
}

if (!window.memos) {
  window.memos = {};
}

const funcsByType = {
  osc: "createOscillator",
  filter: "createBiquadFilter",
  gain: "createGain",
  convolver: "createConvolver",
  compressor: "createDynamicsCompressor",
};

function createNode(type, id, params) {
  const { ac } = window;
  const func = funcsByType[type];
  if (!func) {
    throw new Error(`Unsupported node type: ${type} [${id}]`);
  }

  let node = window.nodes[id];
  if (!node) {
    node = window.nodes[id] = ac[func]();
    node.id = id;

    if (typeof node.start === "function") {
      const origStart = node.start;

      node.isStarted = false;
      node.start = (time) => {
        if (node.isStarted) {
          return;
        }
        node.isStarted = true;

        return origStart.call(node, time);
      };
    }

    node.connectedTo = {};

    const origConnect = node.connect;
    const origDisconnect = node.disconnect;

    node.connect = (dest, ...rest) => {
      // Already connected.
      if (dest.id && !!node.connectedTo[dest.id]) {
        return dest;
      }

      return origConnect.call(node, dest, ...rest);
    };

    node.disconnect = (dest) => {
      console.log("disconnect", id, dest);
      if (!dest) {
        node.connectedTo = {};
      }
      if (dest?.id) {
        delete node.connectedTo[dest.id];
      }

      return origDisconnect.call(node, dest);
    };
  }

  if (params) {
    setParams(node, params);
  }

  return node;
}

Object.keys(funcsByType).forEach(
  (type) => (createNode[type] = createNode.bind(null, type)),
);

function impulseResponse(duration, decay, reverse) {
  const { ac } = window;

  var sampleRate = ac.sampleRate;
  var length = sampleRate * duration;
  var impulse = ac.createBuffer(2, length, sampleRate);
  var impulseL = impulse.getChannelData(0);
  var impulseR = impulse.getChannelData(1);

  if (!decay) decay = 2.0;
  for (var i = 0; i < length; i++) {
    var n = reverse ? length - i : i;
    impulseL[i] = (Math.random() * 2 - 1) * Math.pow(1 - n / length, decay);
    impulseR[i] = (Math.random() * 2 - 1) * Math.pow(1 - n / length, decay);
  }

  return impulse;
}

function createOscSource(suffix = "") {
  const osc = createNode.osc(`source-osc-${suffix}`);
  const amp = createNode.gain(`source-amp-${suffix}`);

  osc.connect(amp);
  osc.start();

  return {
    osc,
    amp,

    out: amp,
  };
}

function createReverb(prefix = "") {
  const input = createNode.gain(`${prefix}-gainIn`);

  const reverb = createNode.convolver(`${prefix}-convolver`, {
    buffer: impulseResponse(4, 8, false),
  });

  const filter = createNode.filter(`${prefix}-filter`);

  const out = createNode.gain(`${prefix}-gainOut`);
  const wet = createNode.gain(`${prefix}-gainWet`);
  const dry = createNode.gain(`${prefix}-gainDry`);

  connectAll(input, dry, out);
  connectAll(input, wet, reverb, filter, out);

  return {
    input,
    out,
    filter,
    reverb,
    wet,
    dry,
    setMix: (mix) => {
      mix = Math.max(0, Math.min(mix, 1.0));

      const { currentTime } = window.ac;
      dry.gain.setValueAtTime(mix, currentTime);
      wet.gain.setValueAtTime(1.0 - mix, currentTime);
    },
  };
}

function createSynth_a(prefix = "") {
  const out = createNode.gain(`${prefix}-out`, {
    gain: 0,
  });

  const source = createOscSource(`${prefix}-source`);

  const filter = createNode.filter(`${prefix}-filter`, {
    type: "lowpass",
    frequency: 500,
    Q: 10,
  });

  const lfo1 = createOscSource(`${prefix}-lfo1`);
  const lfo2 = createOscSource(`${prefix}-lfo2`);

  connectAll(source.out, filter, out);

  return {
    out,
    source,
    filter,
    lfo1,
    lfo2,
  };
}

function createSynth_b(prefix = "") {
  const frequency = 110;

  const out = createNode.gain(`${prefix}-out`);

  const source1 = createOscSource(`${prefix}-source1`);

  setParams(source1.osc, {
    type: "triangle",
    frequency,
  });

  setParams(source1.amp, {
    gain: 0.2,
  });

  const source2 = createOscSource(`${prefix}-source2`);

  setParams(source2.osc, {
    type: "triangle",
    frequency: frequency * 0.5,
    detune: -1,
  });

  setParams(source2.amp, {
    gain: 0.5,
  });

  const filter1 = createNode.filter(`${prefix}-filter1`, {
    type: "lowpass",
    frequency: 1000,
    Q: 10,
  });

  const filter2 = createNode.filter(`${prefix}-filter2`, {
    type: "lowpass",
    frequency: 1000,
    Q: 10,
  });

  const lfo1 = createOscSource(`${prefix}-lfo1`);

  setParams(lfo1.osc, {
    type: "sine",
    frequency: 0.1,
  });

  setParams(lfo1.amp, {
    gain: 200,
  });

  // Rewire
  lfo1.out.disconnect();
  lfo1.out.connect(filter1.frequency);

  const lfo2 = createOscSource(`${prefix}-lfo2`);

  setParams(lfo2.osc, {
    type: "sine",
    frequency: 0.17,
  });

  setParams(lfo2.amp, {
    gain: 500,
  });

  // Rewire
  lfo2.out.disconnect();
  lfo2.out.connect(filter2.frequency);

  connectAll(source1.out, filter1, out);
  connectAll(source2.out, filter2, out);

  return {
    out,
    source1,
    source2,
    filter1,
    filter2,
    lfo1,
    lfo2,
  };
}

function createMachine_a() {
  const frequency = 55;

  const synth1 = createSynth_a("synth-1");

  setParams(synth1.source.osc, {
    type: "triangle",
    frequency,
  });

  setParams(synth1.lfo1.osc, {
    type: "sine",
    frequency: 0.1,
  });

  setParams(synth1.lfo1.amp, {
    gain: 200,
  });

  synth1.lfo1.out.disconnect();
  //synth1.lfo1.out.connect(synth1.filter.frequency);

  setParams(synth1.lfo2.osc, {
    type: "sine",
    frequency: 0.17,
  });

  setParams(synth1.lfo2.amp, {
    gain: 10,
  });

  synth1.lfo2.out.disconnect();
  //synth1.lfo2.out.connect(synth1.filter.Q);

  // ---

  const synth2 = createSynth_a("synth-2");

  setParams(synth2.source.osc, {
    type: "triangle",
    frequency,
    //detune: -1,
  });

  setParams(synth2.lfo1.osc, {
    type: "sine",
    frequency: 10.5,
  });

  setParams(synth2.lfo1.amp, {
    gain: 1,
  });

  synth2.lfo1.out.disconnect();
  //synth2.lfo1.out.connect(synth2.source.osc.detune);

  setParams(synth2.lfo2.osc, {
    type: "sine",
    frequency: 0.27,
  });

  setParams(synth2.lfo2.amp, {
    gain: 10,
  });

  synth2.lfo2.out.disconnect();
  //synth2.lfo2.out.connect(synth2.filter.Q);

  // ---

  const reverb1 = createReverb("reverb-1");

  reverb1.setMix(0.7);
  setParams(reverb1.filter, {
    type: "lowpass",
    frequency: 5000,
  });

  synth1.out.disconnect();
  synth1.out.connect(reverb1.input);

  synth2.out.disconnect();
  synth2.out.connect(reverb1.input);

  synth1.source.amp.gain.value = 0.3;
  synth2.source.amp.gain.value = 0.3;

  return {
    out: reverb1.out,

    noteOn({ midiNote, time = ac.currentTime }) {
      const frequency = midiToFreq(midiNote);

      synth1.source.osc.frequency.setValueAtTime(frequency, time);
      synth2.source.osc.frequency.setValueAtTime(frequency, time);

      doAttack(synth1.out.gain, { a: 1.2 });
      doAttack(synth2.out.gain, { a: 1.2 });

      synth1.filter.frequency.cancelAndHoldAtTime(time);
      synth1.filter.frequency.setValueAtTime(10000, time);
      synth1.filter.frequency.setTargetAtTime(100, time, 0.03);

      synth2.filter.frequency.cancelAndHoldAtTime(time);
      synth2.filter.frequency.setValueAtTime(10000, time);
      synth2.filter.frequency.setTargetAtTime(100, time, 0.03);

      synth2.source.osc.detune.cancelAndHoldAtTime(time);
      synth2.source.osc.detune.setValueAtTime(100, time);
      synth2.source.osc.detune.setTargetAtTime(0, time, 0.3);
    },

    noteOff({ midiNote, time = ac.currentTime }) {
      doRelease(synth1.out.gain, { r: 0.8 });
      doRelease(synth2.out.gain, { r: 0.2 });
    },
  };
}

function createMachine_b() {
  const freqFactor = 2;
  const gainFactor = 4;
  const kFactor = -1.2;

  const createVoice = (num) => {
    const prefix = `m-b-${num}`;
    const osc = createNode.osc(`${prefix}-osc`, {
      type: "sine",
    });

    const amp = createNode.gain(`${prefix}-amp`, {
      gain: 0.8,
    });

    const filter = createNode.filter(`${prefix}-filter`, {
      type: "lowpass",
      frequency: 5000,
    });

    const out = createNode.gain(`${prefix}-out`, {
      gain: 0,
    });

    connectAll(osc, amp, filter, out);

    const fmOsc = createNode.osc(`${prefix}-fmOsc`, {
      type: "sine",
    });

    const fmGain = createNode.gain(`${prefix}-fmGain`, {
      gain: 0,
    });

    connectAll(fmOsc, fmGain, osc.frequency);

    osc.start();
    fmOsc.start();

    const lfo = createOscSource(`${prefix}-lfo`);

    setParams(lfo.osc, {
      type: "sine",
      frequency: 2,
    });

    setParams(lfo.amp, {
      gain: 20,
    });

    // Rewire
    lfo.out.disconnect();
    lfo.out.connect(filter.frequency);

    return {
      osc,
      amp,
      filter,
      out,
      fmOsc,
      fmGain,
    };
  };

  const out = createNode.gain("m-b-master", {
    gain: 1.0,
  });

  const comp = createNode.compressor("m-b-comp", {
    threshold: -20,
    knee: 10,
    ratio: 12,
    attack: 0,
    release: 0.25,
  });

  comp.connect(out);

  const numVoices = 8;
  const voices = [];
  for (let i = 0; i < numVoices; i += 1) {
    voices.push(createVoice(i));
    voices[i].out.connect(comp);
  }

  let lastVoice = -1;
  const voiceMap = {};

  const getVoice = () => {
    lastVoice = (lastVoice + 1) % numVoices;
    const voice = voices[lastVoice];

    return voice;
  };

  return {
    out,

    noteOn({ midiNote, velocity = 1.0, time = ac.currentTime }) {
      if (voiceMap[midiNote]) {
        console.warn("voice already active:", midiNote);
        return;
      }

      const voice = getVoice();
      voiceMap[midiNote] = voice;

      const frequency = midiToFreq(midiNote);

      const { osc, filter, fmOsc, fmGain } = voice;

      osc.frequency.setValueAtTime(frequency, time);
      fmOsc.frequency.setValueAtTime(frequency * freqFactor, time);

      const fmGainFrom =
        frequency *
      gainFactor *
      velocity *
      Math.pow(2, ((midiNote - 60) / 12) * kFactor);

      fmGain.gain.setValueAtTime(0, time);
      fmGain.gain.linearRampToValueAtTime(fmGainFrom, time + 0.01);
      fmGain.gain.setTargetAtTime(fmGainFrom * 0.1, time + 0.01 + 0.01, 0.8);

      filter.frequency.setValueAtTime(5000, time);
      filter.frequency.setTargetAtTime(100, time + 0.2, 0.2);

      doAttack(voice.out.gain, { a: 0.02, s: 0.7, d: 0.7 });

      voice.out.gain.setTargetAtTime(0, time + 2.0, 0.9);
    },

    noteOff({ midiNote, time = ac.currentTime }) {
      const voice = voiceMap[midiNote];
      if (!voice) {
        console.error("voice not found:", midiNote);
        return;
      }

      const { out } = voice;
      doRelease(out.gain, { r: 0.1 });

      delete voiceMap[midiNote];
    },

    voiceMap,
  };
}

function Chords({ mach1 }) {
  const [
    chords, 
    raw, 
    setRaw, 
    parse,
  ] = useChordStore((s) => [
    s.chords,
    s.raw,
    s.setRaw,
    s.parse
  ]);
  
  const [
    currentChord,
    setCurrentChord,
    
    currentNotes,
    setCurrentNotes,
  ] = useStore((s) => [
    s.currentChord,
    s.setCurrentChord,
    
    s.currentNotes,
    s.setCurrentNotes,
  ])

  let i = 0;

  function playChord(i) {
    if (currentNotes.length) {
      currentNotes.forEach((midiNote) => mach1.noteOff({ midiNote }));
      setCurrentNotes([]);
    }

    // Stop
    if (i === currentChord) {
      setCurrentChord(null);
      return;
    }

    const notes = parse(chords[i]);
    setCurrentNotes(notes);
    setCurrentChord(i);

    const time = ac.currentTime;
    notes.forEach((midiNote, i) => {
      mach1.noteOn({ midiNote, velocity: 1.0 - (i * 0.2) / 1, time });
    });
  }

  const onChangeRaw = (e) => {
    const { value } = e.target;

    setRaw(value);
  };

  return (
    <>
      <div className="flex-grow">
        <textarea
          style={{ height: '100%', padding: 8 }}
          className="flex-grow"
          defaultValue={raw}
          placeholder="C4 0 4 7"
          onChange={onChangeRaw}
        />
      </div>

      <div className="m-chords gap-5">
        {chords.map((chord, i) => (
          <div key={i} style={{marginBottom: 8}} className="flex flex-row gap-5">
            <button
              style={{width: '100%'}}
              className={currentChord === i ? "playing" : ""}
              onClick={() => playChord(i)}
            >
              {chord}
            </button>
            
            <ChordMap notes={parse(chord)} currentNotes={parse(chords[currentChord])} />
          </div>
        ))}
      </div>
    </>
  );
}

function ChordMap ({ notes=[], currentNotes=[] }) {
  const semitones = []
  for (let i = 30; i < 80; i += 1) {
    semitones.push(i)
  }

  const getColor = (st) => {
    if (notes.includes(st) && currentNotes.includes(st)) {
      return 'magenta'
    }
    
    if (notes.includes(st)) {
      return 'orangered'
    }
    
    if (currentNotes.includes(st)) {
      return 'darkslategrey'
    }
    
    return ''
  }

  return (
    <div className="m-chordMap">
      { semitones.map(st => {
          const note = ''

        return <span key={st} style={{ backgroundColor: getColor(st) }} title={`${st} ${note}`}></span>
      }) }
    </div>
  )
}

function LoadedApp() {
  const { ac } = window;
  ac.destination.id = "__destination";

  const master = createNode.gain("master");
  const mach1 = createMachine_b();

  useEffect(() => {
    master.connect(ac.destination);

    mach1.out.disconnect();
    mach1.out.connect(master);
  }, []);

  return (
  <>
    <ClipMeter inputNode={master} />
    <div className="flex flex-row gap-5">
      <Chords mach1={mach1} />
    </div>
  </>
  );
}

function App() {
  return (
    <Boot>
      <LoadedApp />
    </Boot>
  );
}

export default App;
