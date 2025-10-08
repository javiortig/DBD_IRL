// app/index.tsx
// Motor (80%) + Zona de Patada (20%).
// Regresión + chispazos (Gen_Spark1..9) 5–7s sin reparar.
// Multitouch fluido, audio por tramos, completed loop+notif, landscape.
// Hover centrado, patada con cooldown y tick, Skill Checks estilo DBD (timers separados).
// Menú de AJUSTES (popup) con borrador editable y botón “Aplicar cambios”. Reset de motor sin tocar ajustes.
// BLOQUEO: no permite reparar ni toques, pero SÍ deja que la regresión avance.
// Toast propio (multiplataforma) para confirmar acciones.
// Marca de umbral de recuperación durante la regresión.

import { Audio } from "expo-av";
import * as Haptics from "expo-haptics";
import { useKeepAwake } from "expo-keep-awake";
import * as ScreenOrientation from "expo-screen-orientation";
import React, { useEffect, useRef, useState } from "react";
import {
  AppState,
  findNodeHandle,
  GestureResponderEvent,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  UIManager,
  View,
} from "react-native";

// ==== Barra (visual) ====
const BAR_H = 22;
const BAR_R = 12;

// ==== Hover ====
const RING_SIZE = 96;
const RING_RADIUS = RING_SIZE / 2;

// ==== Skill Check (círculo objetivo) ====
const SKILL_RING_SIZE = 96;
const SKILL_RING_RADIUS = SKILL_RING_SIZE / 2;

// ==== Audio ====
const VOL = 0.7;
const XFADE_MS = 160;

// ==== Patada ====
const KICK_HOLD_MS = 3000; // mantener 3s para patear (fijo)

// ==== SFX ====
const SFX = {
  // Loops progreso
  gen1: require("../assets/sfx/Gen1.wav"),
  gen1Repair: require("../assets/sfx/Gen1_Repairing.wav"),
  gen2: require("../assets/sfx/Gen2.wav"),
  gen2Repair: require("../assets/sfx/Gen2_Repairing.wav"),
  gen3: require("../assets/sfx/Gen3.wav"),
  gen3Repair: require("../assets/sfx/Gen3_Repairing.wav"),
  gen4: require("../assets/sfx/Gen4.wav"),
  gen4Repair: require("../assets/sfx/Gen4_Repairing.wav"),

  // Completado
  completed: require("../assets/sfx/Generator_Completed.wav"),
  completedNotif: require("../assets/sfx/Generator_Completed_Notification.wav"),

  // Patada
  break: require("../assets/sfx/Generator_Break.wav"),
  kickTick: require("../assets/sfx/Gen_Kick.wav"),

  // Chispazos
  spark1: require("../assets/sfx/sparks/Gen_Spark1.wav"),
  spark2: require("../assets/sfx/sparks/Gen_Spark2.wav"),
  spark3: require("../assets/sfx/sparks/Gen_Spark3.wav"),
  spark4: require("../assets/sfx/sparks/Gen_Spark4.wav"),
  spark5: require("../assets/sfx/sparks/Gen_Spark5.wav"),
  spark6: require("../assets/sfx/sparks/Gen_Spark6.wav"),
  spark7: require("../assets/sfx/sparks/Gen_Spark7.wav"),
  spark8: require("../assets/sfx/sparks/Gen_Spark8.wav"),
  spark9: require("../assets/sfx/sparks/Gen_Spark9.wav"),

  // Skill checks
  skillCheck: require("../assets/sfx/Skill_Check.wav"),
  explode: require("../assets/sfx/Gen_Explode.wav"),
  good: require("../assets/sfx/Good_Skill_Check.wav"),
} as const;

type TrackKey = keyof typeof SFX;
type SkillState = "NONE" | "RELEASE" | "AIM_PENDING" | "AIM_ACTIVE";

// ===== AJUSTES =====
type Settings = {
  maxPlayers: number;                 // MAX_PLAYERS
  soloSeconds: number;                // SOLO_SECONDS (s)
  maxPlayerPenalty: number;           // MAX_PLAYER_REPAIR_PENALTY
  kickCooldownMs: number;             // KICK_COOLDOWN_MS (ms)
  blockKickMs: number;                // BLOQUEO por patada
  blockExplodeMs: number;             // BLOQUEO por explosión
  blockDropMs: number;                // BLOQUEO por abandono
  regressionSpeedMult: number;        // REGRESSION_SPEED_MULT
  regressionRecoverAmount: number;    // +X (0.06 = 6%)
  skillMinS: number;                  // skill min (s) desde que empiezan a reparar
  skillMaxS: number;                  // skill max (s)
  kickStrength: number;               // % progreso que quita la patada (0.20 = 20%)
  explodeStrength: number;            // % progreso que quita la explosión (0.10 = 10%)
};

// >>> Valores predeterminados ACTUALIZADOS <<<
const DEFAULT_SETTINGS: Settings = {
  maxPlayers: 4,
  soloSeconds: 240,
  maxPlayerPenalty: 0.5,
  kickCooldownMs: 25000,
  blockKickMs: 20000,
  blockExplodeMs: 8000,
  blockDropMs: 5000,
  regressionSpeedMult: 0.5,
  regressionRecoverAmount: 0.06,
  skillMinS: 15,
  skillMaxS: 25,
  kickStrength: 0.2,
  explodeStrength: 0.1,
};

// Borrador (strings, permiten vacío)
type SettingsDraft = {
  maxPlayers: string;
  soloSeconds: string;
  maxPlayerPenalty: string;
  kickCooldownS: string;
  blockKickS: string;
  blockExplodeS: string;
  blockDropS: string;
  regressionSpeedMult: string;
  regressionRecoverPercent: string;
  skillMinS: string;
  skillMaxS: string;
  kickStrengthPercent: string;
  explodeStrengthPercent: string;
};

// Helpers
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const toNum = (s: string | undefined, def: number) => {
  if (s == null || s.trim() === "") return def;
  const n = parseFloat(s.replace(",", "."));
  return Number.isFinite(n) ? n : def;
};
const toInt = (s: string | undefined, def: number) => {
  if (s == null || s.trim() === "") return def;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : def;
};
function getSpeedMultiplier(players: number, penalty: number) {
  return Math.pow(players, penalty);
}
function settingsToDraft(s: Settings): SettingsDraft {
  return {
    maxPlayers: String(s.maxPlayers),
    soloSeconds: String(s.soloSeconds),
    maxPlayerPenalty: String(s.maxPlayerPenalty),
    kickCooldownS: String(Math.round(s.kickCooldownMs / 1000)),
    blockKickS: String(Math.round(s.blockKickMs / 1000)),
    blockExplodeS: String(Math.round(s.blockExplodeMs / 1000)),
    blockDropS: String(Math.round(s.blockDropMs / 1000)),
    regressionSpeedMult: String(s.regressionSpeedMult),
    regressionRecoverPercent: String(Math.round(s.regressionRecoverAmount * 100)),
    skillMinS: String(s.skillMinS),
    skillMaxS: String(s.skillMaxS),
    kickStrengthPercent: String(Math.round(s.kickStrength * 100)),
    explodeStrengthPercent: String(Math.round(s.explodeStrength * 100)),
  };
}
function draftToSettings(d: SettingsDraft, current: Settings): Settings {
  // Usa 'current' como fallback para vacíos
  let maxPlayers = clamp(toInt(d.maxPlayers, current.maxPlayers), 1, 8);
  let soloSeconds = clamp(toInt(d.soloSeconds, current.soloSeconds), 5, 600);
  let maxPlayerPenalty = clamp(toNum(d.maxPlayerPenalty, current.maxPlayerPenalty), 0, 2);

  let kickCooldownMs = clamp(toInt(d.kickCooldownS, Math.round(current.kickCooldownMs / 1000)), 0, 600) * 1000;
  let blockKickMs = clamp(toInt(d.blockKickS, Math.round(current.blockKickMs / 1000)), 0, 600) * 1000;
  let blockExplodeMs = clamp(toInt(d.blockExplodeS, Math.round(current.blockExplodeMs / 1000)), 0, 600) * 1000;
  let blockDropMs = clamp(toInt(d.blockDropS, Math.round(current.blockDropMs / 1000)), 0, 600) * 1000;

  let regressionSpeedMult = clamp(toNum(d.regressionSpeedMult, current.regressionSpeedMult), 0, 5);
  let regressionRecoverAmount =
    clamp(toNum(d.regressionRecoverPercent, current.regressionRecoverAmount * 100), 0, 100) / 100;

  let skillMinS = clamp(toInt(d.skillMinS, current.skillMinS), 1, 600);
  let skillMaxS = clamp(toInt(d.skillMaxS, current.skillMaxS), 1, 600);
  if (skillMaxS < skillMinS) skillMaxS = skillMinS;

  let kickStrength = clamp(toNum(d.kickStrengthPercent, current.kickStrength * 100), 0, 100) / 100;
  let explodeStrength = clamp(toNum(d.explodeStrengthPercent, current.explodeStrength * 100), 0, 100) / 100;

  return {
    maxPlayers,
    soloSeconds,
    maxPlayerPenalty,
    kickCooldownMs,
    blockKickMs,
    blockExplodeMs,
    blockDropMs,
    regressionSpeedMult,
    regressionRecoverAmount,
    skillMinS,
    skillMaxS,
    kickStrength,
    explodeStrength,
  };
}

async function fadeVolume(sound: Audio.Sound, from: number, to: number, ms: number) {
  const steps = 6;
  const stepTime = Math.max(10, Math.round(ms / steps));
  for (let i = 0; i <= steps; i++) {
    const v = from + (to - from) * (i / steps);
    await sound.setVolumeAsync(v).catch(() => {});
    if (i < steps) await new Promise((r) => setTimeout(r, stepTime));
  }
}

export default function Engine() {
  useKeepAwake();

  useEffect(() => {
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => {});
  }, []);

  // ===== Toast =====
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (msg: string) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(msg);
    toastTimerRef.current = setTimeout(() => setToast(null), 1600);
  };

  // ===== Settings =====
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const settingsRef = useRef<Settings>(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  // Borrador de ajustes para el popup
  const [draft, setDraft] = useState<SettingsDraft>(settingsToDraft(DEFAULT_SETTINGS));
  const [showSettings, setShowSettings] = useState(false);
  useEffect(() => {
    if (showSettings) {
      setDraft(settingsToDraft(settingsRef.current));
    }
  }, [showSettings]);

  const [progress, setProgress] = useState(0);
  const [playersTouching, setPlayersTouching] = useState(0);
  const [isComplete, setIsComplete] = useState(false);
  const [touchPoints, setTouchPoints] = useState<{ id: number; x: number; y: number }[]>([]);

  const applyDraft = async () => {
    const next = draftToSettings(draft, settingsRef.current);
    setSettings(next);
    try { await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}
    showToast("Ajustes aplicados");
    setShowSettings(false); // <- cerrar popup al aplicar

    // Si ahora mismo están reparando y se puede programar skill, re-arma el temporizador
    if (
      !isComplete &&
      !isBlocked() &&
      !regressionActiveRef.current &&
      playersTouchingRef.current > 0 &&
      skillStateRef.current === "NONE"
    ) {
      clearSkillScheduler();
      scheduleSkillAfterStart();
    }
  };

  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);

  // === Regresión ===
  const regressionActiveRef = useRef(false);
  const [regressionActive, setRegressionActive] = useState(false);
  const regressionRecoverBaselineRef = useRef<number | null>(null);

  // Pulso visual en regresión
  const [regPulse, setRegPulse] = useState(false);
  useEffect(() => {
    if (regressionActive) {
      const id = setInterval(() => setRegPulse((p) => !p), 450);
      return () => clearInterval(id);
    } else {
      setRegPulse(false);
    }
  }, [regressionActive]);

  // Audio
  const soundsRef = useRef<Partial<Record<TrackKey, Audio.Sound>>>({});
  const currentKeyRef = useRef<TrackKey | null>(null);
  const currentRef = useRef<Audio.Sound | null>(null);
  const stoppingRef = useRef(false);

  // Histeresis repairing
  const REPAIRING_ON_DELAY_MS = 10;
  const REPAIRING_OFF_DELAY_MS = 10;
  const [repairingSmooth, setRepairingSmooth] = useState(false);
  const onTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const offTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Retención mínima de pista
  const MIN_TRACK_HOLD_MS = 250;
  const lastSwitchRef = useRef(0);

  // Refs quick
  const lastNativeTouchesCountRef = useRef(0);
  const playersTouchingRef = useRef(0);
  useEffect(() => { playersTouchingRef.current = playersTouching; }, [playersTouching]);

  // Layout del motor
  const engineRef = useRef<View | null>(null);
  const engineRectRef = useRef<{ x: number; y: number; w: number; h: number }>({ x: 0, y: 0, w: 1, h: 1 });
  const measureEngineInWindow = () => {
    const node = findNodeHandle(engineRef.current);
    if (!node) return;
    // @ts-ignore
    UIManager.measureInWindow?.(node, (x: number, y: number, w: number, h: number) => {
      engineRectRef.current = { x, y, w: Math.max(1, w), h: Math.max(1, h) };
    });
  };
  useEffect(() => {
    measureEngineInWindow();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") setTimeout(measureEngineInWindow, 0);
    });
    return () => sub.remove();
  }, []);
  useEffect(() => {
    const t = setTimeout(measureEngineInWindow, 0);
    return () => clearTimeout(t);
  }, []);

  // Audio mode
  useEffect(() => {
    Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      shouldDuckAndroid: true,
      allowsRecordingIOS: false,
    }).catch(() => {});
  }, []);

  // Precarga sonidos
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        for (const key of Object.keys(SFX) as TrackKey[]) {
          if (!mounted) break;
          if (soundsRef.current[key]) continue;
          const { sound } = await Audio.Sound.createAsync(SFX[key], { shouldPlay: false, volume: VOL });
          if (!mounted) {
            await sound.unloadAsync();
            break;
          }
          soundsRef.current[key] = sound;
        }
      } catch {}
    })();
    return () => { mounted = false; };
  }, []);

  // ==== BLOQUEO ====
  const blockUntilRef = useRef<number>(0);
  const [blockedLeftMs, setBlockedLeftMs] = useState(0);
  const isBlocked = () => !isComplete && Date.now() < blockUntilRef.current;
  const setBlocked = (ms: number) => {
    if (isComplete) return;
    const until = Date.now() + ms;
    if (until > blockUntilRef.current) {
      blockUntilRef.current = until;
      setBlockedLeftMs(until - Date.now());
    }
  };
  useEffect(() => {
    const id = setInterval(() => {
      setBlockedLeftMs(Math.max(0, blockUntilRef.current - Date.now()));
    }, 200);
    return () => clearInterval(id);
  }, []);

  // Ventana de gracia para NO bloquear por “drop” tras skill correcta
  const ignoreDropUntilRef = useRef<number>(0);
  const markIgnoreDrop = (ms: number) => {
    const until = Date.now() + ms;
    if (until > ignoreDropUntilRef.current) ignoreDropUntilRef.current = until;
  };

  // === Skill state machine ===
  const [skillState, setSkillState] = useState<SkillState>("NONE");
  const skillStateRef = useRef<SkillState>("NONE");
  useEffect(() => { skillStateRef.current = skillState; }, [skillState]);

  // Scheduler desde que empiezan a reparar (min..max s)
  const skillScheduleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearSkillScheduler = () => {
    if (skillScheduleTimerRef.current) {
      clearTimeout(skillScheduleTimerRef.current);
      skillScheduleTimerRef.current = null;
    }
  };
  const scheduleSkillAfterStart = () => {
    clearSkillScheduler();
    const { skillMinS, skillMaxS } = settingsRef.current;
    const min = Math.max(1, Math.min(skillMinS, skillMaxS));
    const max = Math.max(min, skillMaxS);
    const delay = (min + Math.random() * (max - min)) * 1000;
    skillScheduleTimerRef.current = setTimeout(tryStartSkill, delay);
  };
  const tryStartSkill = () => {
    skillScheduleTimerRef.current = null;
    if (
      !isComplete &&
      !isBlocked() &&
      !regressionActiveRef.current &&
      playersTouchingRef.current > 0 &&
      skillStateRef.current === "NONE"
    ) {
      startSkillReleasePhase().catch(() => {});
    }
  };

  // Timers de fases
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aimArmDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aimAppearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aimDeadlineRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearSkillPhaseTimers = () => {
    if (releaseTimerRef.current) { clearTimeout(releaseTimerRef.current); releaseTimerRef.current = null; }
    if (aimArmDelayRef.current) { clearTimeout(aimArmDelayRef.current); aimArmDelayRef.current = null; }
    if (aimAppearTimerRef.current) { clearTimeout(aimAppearTimerRef.current); aimAppearTimerRef.current = null; }
    if (aimDeadlineRef.current) { clearTimeout(aimDeadlineRef.current); aimDeadlineRef.current = null; }
  };
  const cancelAllSkillTimers = () => { clearSkillScheduler(); clearSkillPhaseTimers(); };

  // Target AIM
  const [skillTarget, setSkillTarget] = useState<{ x: number; y: number } | null>(null);
  const skillTargetRef = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => { skillTargetRef.current = skillTarget; }, [skillTarget]);
  const aimHandledRef = useRef(false);

  // Programación por empezar/dejar de reparar
  const prevRepairingRef = useRef(false);
  useEffect(() => {
    const repairingNow = playersTouching > 0;
    const repairingPrev = prevRepairingRef.current;
    prevRepairingRef.current = repairingNow;

    if (isComplete || isBlocked() || skillState !== "NONE") {
      clearSkillScheduler();
      return;
    }

    if (!repairingPrev && repairingNow) {
      scheduleSkillAfterStart();
      return;
    }

    if (repairingPrev && !repairingNow) {
      clearSkillScheduler();
      // Bloqueo por drop SOLO si no venimos de skill y no estamos en ventana de gracia
      if (skillStateRef.current === "NONE" && !isComplete && Date.now() >= ignoreDropUntilRef.current) {
        setBlocked(settingsRef.current.blockDropMs);
        showToast("Bloqueado por abandono");
      }
      return;
    }
  }, [playersTouching, isComplete, skillState]);

  // Re-armar skill al terminar la regresión si están reparando
  const prevRegressionRef = useRef(regressionActive);
  useEffect(() => {
    const prev = prevRegressionRef.current;
    prevRegressionRef.current = regressionActive;
    if (prev && !regressionActive) {
      if (
        !isComplete &&
        !isBlocked() &&
        skillStateRef.current === "NONE" &&
        playersTouchingRef.current > 0 &&
        !skillScheduleTimerRef.current
      ) {
        scheduleSkillAfterStart();
      }
    }
  }, [regressionActive, isComplete]);

  // --- Progreso + Regresión ---
  useEffect(() => {
    const loop = (ts: number) => {
      if (!lastTsRef.current) lastTsRef.current = ts;
      const dt = Math.min(0.1, (ts - lastTsRef.current) / 1000);
      lastTsRef.current = ts;

      setProgress((prev) => {
        if (isComplete) return prev;
        if (skillStateRef.current !== "NONE") return prev;

        const st = settingsRef.current;
        const basePerSecond = 1 / Math.max(1, st.soloSeconds);
        const repairingAllowed = !isBlocked();
        const effectivePlayers = repairingAllowed ? playersTouching : 0;

        let next = prev;
        const mult = getSpeedMultiplier(effectivePlayers, st.maxPlayerPenalty) * 1;
        const repairRate = basePerSecond * mult;

        const shouldRegress = regressionActiveRef.current && effectivePlayers === 0;
        const regressRate = basePerSecond * st.regressionSpeedMult;

        if (shouldRegress) next = Math.max(0, next - regressRate * dt);
        else next = Math.min(1, next + repairRate * dt);

        if (next <= 0) {
          regressionActiveRef.current = false;
          setRegressionActive(false);
          regressionRecoverBaselineRef.current = null;
        }

        if (regressionActiveRef.current && effectivePlayers > 0) {
          if (regressionRecoverBaselineRef.current === null) {
            regressionRecoverBaselineRef.current = next;
          } else if (next >= regressionRecoverBaselineRef.current + 0.000001 + st.regressionRecoverAmount) {
            regressionActiveRef.current = false;
            setRegressionActive(false);
            regressionRecoverBaselineRef.current = null;
          }
        }

        if (next >= 1 && !isComplete) triggerComplete();
        return next;
      });

      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [playersTouching, isComplete]);

  const triggerComplete = async () => {
    setIsComplete(true);
    clearTouches();
    clearRepairingTimers();
    setRepairingSmooth(false);
    regressionActiveRef.current = false;
    setRegressionActive(false);
    regressionRecoverBaselineRef.current = null;

    try { await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
    await crossfadeTo("completed");
    await playCompletedNotificationOnce();

    cancelAllSkillTimers();
    setSkillState("NONE");
    setSkillTarget(null);

    blockUntilRef.current = 0;
    setBlockedLeftMs(0);
  };

  // Histeresis repairing
  useEffect(() => {
    if (isComplete) return;

    const raw = playersTouching > 0;

    if (onTimerRef.current) { clearTimeout(onTimerRef.current); onTimerRef.current = null; }
    if (offTimerRef.current) { clearTimeout(offTimerRef.current); offTimerRef.current = null; }

    if (raw) {
      if (!repairingSmooth) {
        onTimerRef.current = setTimeout(() => {
          setRepairingSmooth(true);
          onTimerRef.current = null;
        }, REPAIRING_ON_DELAY_MS);
      }
    } else {
      if (repairingSmooth) {
        offTimerRef.current = setTimeout(() => {
          setRepairingSmooth(false);
          offTimerRef.current = null;
        }, REPAIRING_OFF_DELAY_MS);
      }
    }

    return () => {
      if (onTimerRef.current) { clearTimeout(onTimerRef.current); onTimerRef.current = null; }
      if (offTimerRef.current) { clearTimeout(offTimerRef.current); offTimerRef.current = null; }
    };
  }, [playersTouching, repairingSmooth, isComplete]);

  const clearRepairingTimers = () => {
    if (onTimerRef.current) { clearTimeout(onTimerRef.current); onTimerRef.current = null; }
    if (offTimerRef.current) { clearTimeout(offTimerRef.current); offTimerRef.current = null; }
  };

  const playCompletedNotificationOnce = async () => {
    const s = soundsRef.current.completedNotif;
    if (!s) return;
    try {
      await s.setIsLoopingAsync(false);
      await s.setVolumeAsync(VOL);
      await s.setPositionAsync(0);
      await s.playAsync();
    } catch {}
  };

  const chooseLoopTrack = (p: number, repairing: boolean): TrackKey | null => {
    if (p <= 0) return null;
    if (p > 0 && p <= 0.25) return repairing ? "gen1Repair" : "gen1";
    if (p > 0.25 && p <= 0.5) return repairing ? "gen2Repair" : "gen2";
    if (p > 0.5 && p <= 0.75) return repairing ? "gen3Repair" : "gen3";
    if (p > 0.75 && p < 1) return repairing ? "gen4Repair" : "gen4";
    return null;
  };

  useEffect(() => {
    (async () => {
      if (isComplete) {
        if (currentKeyRef.current !== "completed") {
          await crossfadeTo("completed");
        }
        return;
      }
      const desired = chooseLoopTrack(progress, repairingSmooth);
      if (!desired) {
        if (currentRef.current) await crossfadeTo(null);
        return;
      }
      if (desired !== currentKeyRef.current) {
        await crossfadeTo(desired);
      }
    })().catch(() => {});
  }, [progress, repairingSmooth, isComplete]);

  const crossfadeTo = async (key: TrackKey | null) => {
    try {
      const now = Date.now();
      if (currentKeyRef.current !== key && now - lastSwitchRef.current < MIN_TRACK_HOLD_MS) return;
      lastSwitchRef.current = now;

      if (stoppingRef.current) return;
      stoppingRef.current = true;

      const current = currentRef.current;
      let next: Audio.Sound | null = null;

      if (key) {
        next = soundsRef.current[key] ?? null;
        if (next) {
          await next.setIsLoopingAsync(key !== "completedNotif");
          await next.setVolumeAsync(0);
          await next.setPositionAsync(0);
          await next.playAsync();
        }
      }

      if (current && next) {
        await Promise.all([fadeVolume(next, 0, VOL, XFADE_MS), fadeVolume(current, VOL, 0, XFADE_MS)]);
        await current.stopAsync().catch(() => {});
      } else if (!next && current) {
        await fadeVolume(current, VOL, 0, XFADE_MS);
        await current.stopAsync().catch(() => {});
      } else if (next && !current) {
        await fadeVolume(next, 0, VOL, XFADE_MS);
      }

      currentRef.current = key ? next : null;
      currentKeyRef.current = key ?? null;
    } finally {
      stoppingRef.current = false;
    }
  };

  // ===== Multitouch motor =====
  const readAllTouches = (evt?: GestureResponderEvent) => {
    const touches = (evt?.nativeEvent as any)?.touches ?? [];
    const { x, y, w, h } = engineRectRef.current;
    const sliced = touches.slice(0, settingsRef.current.maxPlayers);
    const points = sliced.map((t: any, idx: number) => {
      const px = t.pageX ?? 0;
      const py = t.pageY ?? 0;
      const lx = Math.max(0, Math.min(px - x, w));
      const ly = Math.max(0, Math.min(py - y, h));
      return { id: t.identifier ?? idx, x: lx, y: ly };
    });
    lastNativeTouchesCountRef.current = sliced.length;
    return points as { id: number; x: number; y: number }[];
  };

  const applyTouches = (points: { id: number; x: number; y: number }[]) => {
    if (isBlocked()) {
      clearTouches();
      return;
    }
    setTouchPoints(points);
    setPlayersTouching(points.length);

    // Éxito/fallo durante AIM_ACTIVE
    if (skillStateRef.current === "AIM_ACTIVE" && !aimHandledRef.current) {
      if (points.length > 0) {
        let hit = false;
        const tgt = skillTargetRef.current;
        if (tgt) {
          for (const p of points) {
            const dx = p.x - tgt.x;
            const dy = p.y - tgt.y;
            if (dx * dx + dy * dy <= SKILL_RING_RADIUS * SKILL_RING_RADIUS) {
              hit = true;
              break;
            }
          }
        }
        aimHandledRef.current = true;
        if (hit) handleSkillSuccess();
        else handleSkillFail();
      }
    }

    // Tocar antes de que salga el círculo (AIM_PENDING) => explota
    if (skillStateRef.current === "AIM_PENDING" && points.length > 0) {
      handleSkillFail();
    }
  };

  const clearTouches = () => {
    setTouchPoints([]);
    setPlayersTouching(0);
    lastNativeTouchesCountRef.current = 0;
  };

  const postReleaseDoubleCheck = () => {
    setTimeout(() => {
      if (isComplete) return;
      if (lastNativeTouchesCountRef.current === 0 && playersTouchingRef.current > 0) {
        clearTouches();
      }
    }, 20);
    requestAnimationFrame(() => {
      if (isComplete) return;
      if (lastNativeTouchesCountRef.current === 0 && playersTouchingRef.current > 0) {
        clearTouches();
      }
    });
  };

  const updateTouches = (evt: GestureResponderEvent) => {
    if (isComplete) return;
    applyTouches(readAllTouches(evt));
  };

  // ==== KICK (derecha) ====
  const [kickHold, setKickHold] = useState(0);
  const kickAnimatingRef = useRef(false);
  const kickStartTsRef = useRef<number | null>(null);
  const kickRafRef = useRef<number | null>(null);

  const nextKickAtRef = useRef<number>(0);
  const [kickCooldownLeftMs, setKickCooldownLeftMs] = useState(0);
  const nextKickTickAtRef = useRef<number | null>(null);

  useEffect(() => {
    const id = setInterval(() => {
      setKickCooldownLeftMs(Math.max(0, nextKickAtRef.current - Date.now()));
    }, 200);
    return () => clearInterval(id);
  }, []);

  const kickReset = () => {
    kickAnimatingRef.current = false;
    kickStartTsRef.current = null;
    nextKickTickAtRef.current = null;
    setKickHold(0);
    if (kickRafRef.current) {
      cancelAnimationFrame(kickRafRef.current);
      kickRafRef.current = null;
    }
  };

  const playOnce = async (key: TrackKey) => {
    const s = soundsRef.current[key];
    if (!s) return;
    try {
      await s.setIsLoopingAsync(false);
      await s.setVolumeAsync(VOL);
      await s.setPositionAsync(0);
      await s.playAsync();
    } catch {}
  };

  const kickPlayBreak = () => playOnce("break");
  const kickPlayTick = () => playOnce("kickTick");
  const isKickOnCooldown = () => Date.now() < nextKickAtRef.current;

  const onKickStart = () => {
    if (isComplete) return;
    if (isKickOnCooldown() || skillStateRef.current !== "NONE" || isBlocked()) return;
    if (kickAnimatingRef.current) return;

    kickAnimatingRef.current = true;
    kickStartTsRef.current = Date.now();
    nextKickTickAtRef.current = Date.now();

    const step = () => {
      if (!kickAnimatingRef.current) return;
      if (isKickOnCooldown() || skillStateRef.current !== "NONE" || isBlocked()) {
        kickReset();
        return;
      }

      if (nextKickTickAtRef.current !== null && Date.now() >= nextKickTickAtRef.current) {
        kickPlayTick().catch(() => {});
        nextKickTickAtRef.current += 1000;
      }

      const elapsed = Date.now() - (kickStartTsRef.current ?? Date.now());
      const pct = Math.min(1, elapsed / KICK_HOLD_MS);
      setKickHold(pct);

      if (pct >= 1) {
        kickAnimatingRef.current = false;
        kickRafRef.current = null;
        setKickHold(1);

        kickPlayBreak().catch(() => {});
        setProgress((prev) => Math.max(0, prev - settingsRef.current.kickStrength));
        regressionActiveRef.current = true;
        setRegressionActive(true);
        regressionRecoverBaselineRef.current = null;

        setBlocked(settingsRef.current.blockKickMs);
        showToast("Bloqueado por patada");

        nextKickAtRef.current = Date.now() + settingsRef.current.kickCooldownMs;
        setKickCooldownLeftMs(settingsRef.current.kickCooldownMs);

        nextKickTickAtRef.current = null;
        setTimeout(() => setKickHold(0), 120);
        return;
      }

      kickRafRef.current = requestAnimationFrame(step);
    };

    kickRafRef.current = requestAnimationFrame(step);
  };

  const onKickEnd = () => {
    if (kickAnimatingRef.current) kickReset();
  };

  // ==== CHISPAZOS EN REGRESIÓN ====
  const sparkTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearSparkTimer = () => {
    if (sparkTimeoutRef.current) {
      clearTimeout(sparkTimeoutRef.current);
      sparkTimeoutRef.current = null;
    }
  };
  const scheduleNextSpark = () => {
    clearSparkTimer();
    const delay = 5000 + Math.random() * 2000;
    sparkTimeoutRef.current = setTimeout(async () => {
      if (!isComplete && regressionActiveRef.current && playersTouchingRef.current === 0) {
        const idx = 1 + Math.floor(Math.random() * 9);
        const key = `spark${idx}` as TrackKey;
        playOnce(key).catch(() => {});
      }
      scheduleNextSpark();
    }, delay);
  };
  useEffect(() => {
    if (regressionActive) scheduleNextSpark();
    else clearSparkTimer();
    return () => clearSparkTimer();
  }, [regressionActive]);

  // Limpiezas
  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (kickRafRef.current) cancelAnimationFrame(kickRafRef.current);
      clearSparkTimer();
      cancelAllSkillTimers();
    };
  }, []);

  // Limpia al ir a background
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") {
        resetEngine();
        setTimeout(measureEngineInWindow, 0);
      }
    });
    return () => sub.remove();
  }, []);

  // ===== Fases de SKILL =====
  const startSkillReleasePhase = async () => {
    clearSkillScheduler();
    setSkillState("RELEASE");
    setSkillTarget(null);
    aimHandledRef.current = false;

    playOnce("skillCheck").catch(() => {});

    // 1s para soltar todos
    if (releaseTimerRef.current) clearTimeout(releaseTimerRef.current);
    releaseTimerRef.current = setTimeout(() => {
      if (playersTouchingRef.current > 0) {
        handleSkillFail();
      } else {
        setSkillState("AIM_PENDING");
        if (aimArmDelayRef.current) clearTimeout(aimArmDelayRef.current);
        aimArmDelayRef.current = setTimeout(() => {
          if (aimAppearTimerRef.current) clearTimeout(aimAppearTimerRef.current);
          const delay = Math.floor(Math.random() * 5000); // 0..5s
          aimAppearTimerRef.current = setTimeout(() => {
            startSkillAimActive();
          }, delay);
        }, 1000);
      }
    }, 1000);
  };

  const startSkillAimActive = () => {
    const { w, h } = engineRectRef.current;
    const pad = SKILL_RING_RADIUS + 8;
    const x = pad + Math.random() * Math.max(1, w - 2 * pad);
    const y = pad + Math.random() * Math.max(1, h - 2 * pad);

    setSkillTarget({ x, y });
    aimHandledRef.current = false;
    setSkillState("AIM_ACTIVE");

    if (aimDeadlineRef.current) clearTimeout(aimDeadlineRef.current);
    aimDeadlineRef.current = setTimeout(() => {
      if (!aimHandledRef.current) {
        handleSkillFail();
      }
    }, 1000);
  };

  const handleSkillSuccess = () => {
    clearSkillPhaseTimers();
    setSkillState("NONE");
    setSkillTarget(null);
    playOnce("good").catch(() => {});

    markIgnoreDrop(1500);

    setProgress((prev) => {
      const next = Math.min(1, prev + 0.05);
      if (next >= 1 && !isComplete) setTimeout(() => triggerComplete(), 0);
      return next;
    });
  };

  const handleSkillFail = () => {
    clearSkillPhaseTimers();
    setSkillState("NONE");
    setSkillTarget(null);
    playOnce("explode").catch(() => {});
    setProgress((prev) => Math.max(0, prev - settingsRef.current.explodeStrength));
    regressionActiveRef.current = true;
    setRegressionActive(true);
    regressionRecoverBaselineRef.current = null;
    setBlocked(settingsRef.current.blockExplodeMs);
    showToast("Bloqueado por explosión");
  };

  // ===== Reset motor (sin tocar ajustes) =====
  const resetEngine = () => {
    setIsComplete(false);
    setProgress(0);
    clearTouches();
    setRepairingSmooth(false);

    regressionActiveRef.current = false;
    setRegressionActive(false);
    regressionRecoverBaselineRef.current = null;

    blockUntilRef.current = 0;
    setBlockedLeftMs(0);
    ignoreDropUntilRef.current = 0;

    kickReset();
    nextKickAtRef.current = 0;
    setKickCooldownLeftMs(0);

    cancelAllSkillTimers();
    setSkillState("NONE");
    setSkillTarget(null);

    currentRef.current?.stopAsync().catch(() => {});
    currentRef.current = null;
    currentKeyRef.current = null;

    setShowSettings(false); // <- cerrar popup al reiniciar
    showToast("Motor reiniciado");
  };

  const percent = Math.round(progress * 100);

  // Cooldown patada
  const cooldownSec = kickCooldownLeftMs / 1000;
  const cooldownLabel = cooldownSec > 0 ? `${cooldownSec.toFixed(1)}s` : "Listo";
  const kickAreaDisabled = isComplete || cooldownSec > 0 || skillState !== "NONE" || isBlocked();

  const blockedSec = Math.ceil(blockedLeftMs / 1000);

  // ==== MARCA DE UMBRAL DE RECUPERACIÓN (regresión) ====
  // Se muestra mientras HAY regresión y los jugadores han empezado a reparar de nuevo.
  let recoverMarkLeftPct: string | null = null;
  if (regressionActive && playersTouching > 0) {
    const base = regressionRecoverBaselineRef.current ?? progress;
    const thr = Math.min(1, base + settingsRef.current.regressionRecoverAmount);
    recoverMarkLeftPct = `${thr * 100}%`;
  }

  // ===== UI =====
  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar hidden />

      {/* Botón de Ajustes (esquina superior derecha) */}
      <TouchableOpacity
        style={styles.settingsBtn}
        onPress={() => setShowSettings(true)}
        accessibilityLabel="Abrir ajustes"
      >
        <Text style={styles.settingsBtnText}>⚙️</Text>
      </TouchableOpacity>

      {/* Toast */}
      {toast && (
        <View style={styles.toast}>
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      )}

      <View style={styles.row}>
        {/* Motor */}
        <View
          ref={engineRef}
          style={[
            styles.engineArea,
            isComplete && styles.engineComplete,
            skillState !== "NONE" && styles.engineSkill,
          ]}
          collapsable={false}
          onLayout={measureEngineInWindow}
          pointerEvents={isComplete || isBlocked() ? "none" : "auto"}
          onStartShouldSetResponder={() => !isComplete && !isBlocked()}
          onMoveShouldSetResponder={() => !isComplete && !isBlocked()}
          onResponderGrant={updateTouches}
          onResponderMove={updateTouches}
          onResponderRelease={(e) => { updateTouches(e); postReleaseDoubleCheck(); }}
          onResponderTerminate={() => { clearTouches(); }}
          onTouchEndCapture={(e) => {
            const pts = readAllTouches(e);
            if (pts.length === 0) clearTouches();
            postReleaseDoubleCheck();
          }}
          onTouchCancel={(e) => {
            const pts = readAllTouches(e);
            if (pts.length === 0) clearTouches();
            postReleaseDoubleCheck();
          }}
          accessible
          accessibilityLabel="Área del motor"
        >
          {/* Contenido */}
          <View style={styles.engineContent} pointerEvents="box-none">
            <Text style={styles.title}>MOTOR</Text>

            {/* Avisos Skill */}
            {skillState === "RELEASE" && (
              <View style={styles.skillBadge}>
                <Text style={styles.skillBadgeText}>¡PRUEBA DE HABILIDAD! Soltad todos</Text>
              </View>
            )}
            {skillState === "AIM_PENDING" && (
              <View style={styles.skillBadgeDim}>
                <Text style={styles.skillBadgeTextDim}>Preparados…</Text>
              </View>
            )}
            {skillState === "AIM_ACTIVE" && (
              <View style={styles.skillBadge}>
                <Text style={styles.skillBadgeText}>¡TOCA EL CÍRCULO!</Text>
              </View>
            )}

            {/* Badges de estado */}
            {regressionActive && (
              <View style={styles.regBadge}>
                <Text style={styles.regBadgeText}>REGRESIÓN</Text>
              </View>
            )}
            {isBlocked() && (
              <View style={styles.blockBadge}>
                <Text style={styles.blockBadgeText}>
                  BLOQUEADO {blockedSec > 0 ? `(${blockedSec}s)` : ""}
                </Text>
              </View>
            )}

            {/* Jugadores (oculto si está bloqueado) */}
            {!isComplete && !isBlocked() && (
              <Text style={styles.players}>
                Jugadores reparando: {playersTouching} / {settings.maxPlayers}
              </Text>
            )}

            {/* Barra progreso */}
            <View
              style={[
                styles.progressBar,
                regressionActive && (regPulse ? styles.progressBarRegA : styles.progressBarRegB),
              ]}
              renderToHardwareTextureAndroid
              needsOffscreenAlphaCompositing
            >
              <View style={[styles.progressFill, { width: `${percent}%` }]} />

              {/* Marca de umbral para quitar regresión */}
              {recoverMarkLeftPct && (
                <View style={[styles.regressionMark, { left: recoverMarkLeftPct }]} />
              )}
            </View>

            <Text style={styles.percent}>{percent}%</Text>

            {isComplete ? (
              <Text style={styles.completeLabel}>¡REPARADO!</Text>
            ) : (
              <Text style={styles.hint}>
                {skillState === "NONE"
                  ? isBlocked()
                    ? "Bloqueado…"
                    : `Colocad hasta ${settings.maxPlayers} dedos a la vez`
                  : "Habilidad en curso…"}
              </Text>
            )}
          </View>

          {/* Overlay dedos */}
          {!isComplete && !isBlocked() && (
            <View style={styles.ringsOverlay} pointerEvents="none">
              {touchPoints.map((p) => (
                <View key={p.id} style={[styles.touchRing, { left: p.x, top: p.y }]} />
              ))}
            </View>
          )}

          {/* Overlay Círculo Skill (verde amarillento) */}
          {skillState === "AIM_ACTIVE" && skillTarget && (
            <View style={styles.skillOverlay} pointerEvents="none">
              <View style={[styles.skillRing, { left: skillTarget.x, top: skillTarget.y }]} />
            </View>
          )}
        </View>

        {/* Patada */}
        <View
          style={[
            styles.kickArea,
            (isComplete || cooldownSec > 0 || skillState !== "NONE" || isBlocked()) && styles.kickDisabled,
          ]}
          onStartShouldSetResponder={() => !kickAreaDisabled}
          onMoveShouldSetResponder={() => !kickAreaDisabled}
          onResponderGrant={() => { if (!kickAreaDisabled) onKickStart(); }}
          onResponderRelease={onKickEnd}
          onResponderTerminate={onKickEnd}
          accessible
          accessibilityLabel="Zona de patada del asesino"
        >
          <Text style={styles.kickTitle}>PATADA</Text>
          <Text style={styles.kickHint}>
            {cooldownSec > 0
              ? `Espera ${cooldownLabel}`
              : skillState !== "NONE"
              ? "Bloqueado por skill"
              : isBlocked()
              ? "Bloqueado…"
              : "Mantén 3s"}
          </Text>

          <View style={styles.kickBar}>
            <View style={[styles.kickFill, { height: `${Math.round(kickHold * 100)}%` }]} />
          </View>
        </View>
      </View>

      {/* ======= POPUP AJUSTES ======= */}
      {showSettings && (
        <View style={styles.modalBackdrop} pointerEvents="auto">
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Ajustes</Text>
              <TouchableOpacity onPress={() => setShowSettings(false)} accessibilityLabel="Cerrar ajustes">
                <Text style={styles.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>

            <ScrollView style={styles.modalScroll} contentContainerStyle={{ paddingBottom: 24 }}>
              {/* Campos */}
              <SettingNumber
                label="Número máximo de jugadores"
                value={draft.maxPlayers}
                onChange={(txt) => setDraft((d) => ({ ...d, maxPlayers: txt }))}
                suffix=""
                keyboard="number-pad"
              />
              <SettingNumber
                label="Tiempo de reparación base (s)"
                value={draft.soloSeconds}
                onChange={(txt) => setDraft((d) => ({ ...d, soloSeconds: txt }))}
                suffix="s"
                keyboard="number-pad"
              />
              <SettingNumber
                label="Penalización de reparación por jugador"
                value={draft.maxPlayerPenalty}
                onChange={(txt) => setDraft((d) => ({ ...d, maxPlayerPenalty: txt }))}
                keyboard="decimal-pad"
              />
              <SettingNumber
                label="Enfriamiento de la patada (s)"
                value={draft.kickCooldownS}
                onChange={(txt) => setDraft((d) => ({ ...d, kickCooldownS: txt }))}
                suffix="s"
                keyboard="number-pad"
              />
              <SettingNumber
                label="Tiempo de bloqueo por patada (s)"
                value={draft.blockKickS}
                onChange={(txt) => setDraft((d) => ({ ...d, blockKickS: txt }))}
                suffix="s"
                keyboard="number-pad"
              />
              <SettingNumber
                label="Tiempo de bloqueo por explosión (s)"
                value={draft.blockExplodeS}
                onChange={(txt) => setDraft((d) => ({ ...d, blockExplodeS: txt }))}
                suffix="s"
                keyboard="number-pad"
              />
              <SettingNumber
                label="Tiempo de bloqueo por abandono (s)"
                value={draft.blockDropS}
                onChange={(txt) => setDraft((d) => ({ ...d, blockDropS: txt }))}
                suffix="s"
                keyboard="number-pad"
              />
              <SettingNumber
                label="Multiplicador de la regresión"
                value={draft.regressionSpeedMult}
                onChange={(txt) => setDraft((d) => ({ ...d, regressionSpeedMult: txt }))}
                keyboard="decimal-pad"
              />
              <SettingNumber
                label="Recuperación de la regresión (%)"
                value={draft.regressionRecoverPercent}
                onChange={(txt) => setDraft((d) => ({ ...d, regressionRecoverPercent: txt }))}
                suffix="%"
                keyboard="decimal-pad"
              />
              <SettingNumber
                label="Skillcheck: tiempo mínimo (s)"
                value={draft.skillMinS}
                onChange={(txt) => setDraft((d) => ({ ...d, skillMinS: txt }))}
                suffix="s"
                keyboard="number-pad"
              />
              <SettingNumber
                label="Skillcheck: tiempo máximo (s)"
                value={draft.skillMaxS}
                onChange={(txt) => setDraft((d) => ({ ...d, skillMaxS: txt }))}
                suffix="s"
                keyboard="number-pad"
              />
              <SettingNumber
                label="Fuerza de la patada (%)"
                value={draft.kickStrengthPercent}
                onChange={(txt) => setDraft((d) => ({ ...d, kickStrengthPercent: txt }))}
                suffix="%"
                keyboard="decimal-pad"
              />
              <SettingNumber
                label="Fuerza de la explosión (%)"
                value={draft.explodeStrengthPercent}
                onChange={(txt) => setDraft((d) => ({ ...d, explodeStrengthPercent: txt }))}
                suffix="%"
                keyboard="decimal-pad"
              />

              {/* Botones acción */}
              <TouchableOpacity style={styles.applyBtn} onPress={applyDraft}>
                <Text style={styles.applyBtnText}>Aplicar cambios</Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.resetBtn} onPress={resetEngine}>
                <Text style={styles.resetBtnText}>Reiniciar motor</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

/** === Componente fila de ajuste numérico simple === */
function SettingNumber({
  label,
  value,
  onChange,
  suffix,
  keyboard = "numeric",
}: {
  label: string;
  value: string;
  onChange: (txt: string) => void;
  suffix?: string;
  keyboard?: "numeric" | "number-pad" | "decimal-pad";
}) {
  return (
    <View style={styles.settingRow}>
      <Text style={styles.settingLabel}>{label}</Text>
      <View style={styles.settingInputWrap}>
        <TextInput
          style={styles.settingInput}
          keyboardType={keyboard}
          value={value}
          onChangeText={onChange}
          placeholder=""
          placeholderTextColor="#64748b"
        />
        {suffix ? <Text style={styles.settingSuffix}>{suffix}</Text> : null}
      </View>
    </View>
  );
}

// ==== Estilos ====
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#0b0e10" },
  row: { flex: 1, flexDirection: "row" },

  // Motor
  engineArea: {
    flex: 1,
    marginRight: 10,
    borderRadius: 20,
    borderWidth: 2,
    borderColor: "#333",
    backgroundColor: "#12161a",
    alignItems: "center",
    justifyContent: "center",
    position: "relative",
    overflow: "hidden",
    paddingHorizontal: 24,
    paddingVertical: 16,
  },
  engineComplete: { borderColor: "#4ade80", backgroundColor: "#122417" },
  engineSkill: { borderColor: "#f59e0b", backgroundColor: "#1f1a0a" },

  engineContent: {
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    position: "relative",
    zIndex: 1,
    width: "100%",
  },

  title: { color: "#e5e7eb", fontSize: 34, fontWeight: "800", letterSpacing: 2, textAlign: "center" },
  players: { color: "#9ca3af", fontSize: 18, textAlign: "center" },

  // Badges
  regBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#7f1d1d",
    backgroundColor: "rgba(239,68,68,0.15)",
  },
  regBadgeText: { color: "#fca5a5", fontSize: 13, fontWeight: "800", letterSpacing: 1 },

  blockBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#334155",
    backgroundColor: "rgba(148,163,184,0.2)",
  },
  blockBadgeText: { color: "#cbd5e1", fontSize: 13, fontWeight: "800", letterSpacing: 1 },

  skillBadge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#b45309",
    backgroundColor: "rgba(245,158,11,0.18)",
  },
  skillBadgeText: { color: "#fbbf24", fontSize: 14, fontWeight: "900", letterSpacing: 1 },

  skillBadgeDim: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#6b7280",
    backgroundColor: "rgba(156,163,175,0.15)",
  },
  skillBadgeTextDim: { color: "#d1d5db", fontSize: 13, fontWeight: "800", letterSpacing: 1 },

  // Barra
  progressBar: {
    width: "90%",
    height: BAR_H,
    borderRadius: BAR_R,
    backgroundColor: "#111827",
    borderWidth: 1,
    borderColor: "#374151",
    overflow: "hidden",
    opacity: 0.999,
    alignSelf: "center",
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    position: "relative",
  },
  progressFill: {
    height: "100%",
    backgroundColor: "#60a5fa",
    borderTopRightRadius: BAR_R,
    borderBottomRightRadius: BAR_R,
  },
  // Marca de recuperación de regresión
  regressionMark: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 2,
    backgroundColor: "#ef4444",
    zIndex: 2,
    transform: [{ translateX: -1 }],
  },

  // Pulso rojo durante REGRESIÓN
  progressBarRegA: {
    borderColor: "#ef4444",
    shadowColor: "#ef4444",
    shadowOpacity: 0.55,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
    elevation: 10,
  },
  progressBarRegB: {
    borderColor: "#b91c1c",
    shadowColor: "#b91c1c",
    shadowOpacity: 0.35,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 0 },
    elevation: 6,
  },

  percent: { color: "#e5e7eb", fontSize: 18, fontVariant: ["tabular-nums"], textAlign: "center" },
  completeLabel: { color: "#4ade80", fontSize: 22, fontWeight: "700", textAlign: "center" },
  hint: { color: "#94a3b8", fontSize: 16, textAlign: "center" },

  // Overlay dedos
  ringsOverlay: { position: "absolute", left: 0, top: 0, right: 0, bottom: 0, zIndex: 2 },
  touchRing: {
    position: "absolute",
    width: RING_SIZE,
    height: RING_SIZE,
    borderRadius: RING_RADIUS,
    borderWidth: 2,
    borderColor: "#60a5fa",
    backgroundColor: "rgba(96,165,250,0.15)",
    shadowColor: "#60a5fa",
    shadowOpacity: 0.6,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
    transform: [{ translateX: -RING_RADIUS }, { translateY: -RING_RADIUS * 1.5 }],
  },

  // Overlay Círculo Skill (verde amarillento)
  skillOverlay: { position: "absolute", left: 0, top: 0, right: 0, bottom: 0, zIndex: 3 },
  skillRing: {
    position: "absolute",
    width: SKILL_RING_SIZE,
    height: SKILL_RING_SIZE,
    borderRadius: SKILL_RING_RADIUS,
    borderWidth: 3,
    borderColor: "#a3e635",
    backgroundColor: "rgba(163,230,53,0.18)",
    shadowColor: "#a3e635",
    shadowOpacity: 0.6,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 0 },
    transform: [{ translateX: -SKILL_RING_RADIUS }, { translateY: -SKILL_RING_RADIUS }],
  },

  // Patada
  kickArea: {
    width: "20%",
    borderRadius: 20,
    borderWidth: 2,
    borderColor: "#7f1d1d",
    backgroundColor: "#0b0b0c",
    alignItems: "center",
    justifyContent: "center",
    padding: 12,
    marginLeft: 10,
  },
  kickDisabled: { opacity: 0.6 },
  kickTitle: { color: "#fecaca", fontSize: 20, fontWeight: "800", letterSpacing: 1, marginBottom: 6 },
  kickHint: { color: "#fca5a5", fontSize: 14, marginBottom: 10 },
  kickBar: {
    width: "60%",
    height: "60%",
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: "#ef4444",
    backgroundColor: "#1a0d0d",
    overflow: "hidden",
    alignItems: "stretch",
    justifyContent: "flex-end",
  },
  kickFill: { width: "100%", backgroundColor: "#ef4444" },

  // Settings button
  settingsBtn: {
    position: "absolute",
    top: 8,
    right: 8,
    zIndex: 20,
    backgroundColor: "rgba(30,41,59,0.7)",
    borderColor: "#475569",
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  settingsBtnText: { color: "#e2e8f0", fontSize: 16 },

  // Toast
  toast: {
    position: "absolute",
    bottom: 14,
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 25,
  },
  toastText: {
    backgroundColor: "rgba(15,23,42,0.9)",
    color: "#e5e7eb",
    borderColor: "#334155",
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    overflow: "hidden",
  },

  // Modal ajustes
  modalBackdrop: {
    position: "absolute",
    left: 0, right: 0, top: 0, bottom: 0,
    backgroundColor: "rgba(0,0,0,0.6)",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 30,
    paddingHorizontal: 12,
  },
  modalCard: {
    width: "92%",
    maxWidth: 640,
    maxHeight: "86%",
    backgroundColor: "#0b0f14",
    borderColor: "#334155",
    borderWidth: 1,
    borderRadius: 16,
    padding: 12,
  },
  modalHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  modalTitle: { color: "#e5e7eb", fontSize: 18, fontWeight: "800", letterSpacing: 0.5 },
  modalClose: { color: "#94a3b8", fontSize: 20, padding: 6 },

  modalScroll: {
    borderTopWidth: 1,
    borderTopColor: "#1f2937",
    paddingTop: 10,
  },

  settingRow: { marginBottom: 12, gap: 6 },
  settingLabel: { color: "#cbd5e1", fontSize: 14, fontWeight: "600" },
  settingInputWrap: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#0f172a",
    borderColor: "#334155",
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  settingInput: {
    flex: 1,
    color: "#e5e7eb",
    fontSize: 16,
    paddingVertical: 6,
    paddingHorizontal: 6,
  },
  settingSuffix: { color: "#94a3b8", fontSize: 14, marginLeft: 8 },

  applyBtn: {
    marginTop: 6,
    backgroundColor: "#0ea5e9",
    borderColor: "#0284c7",
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: "center",
  },
  applyBtnText: { color: "#082f49", fontSize: 16, fontWeight: "800" },

  resetBtn: {
    marginTop: 10,
    backgroundColor: "#1e293b",
    borderColor: "#475569",
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: "center",
  },
  resetBtnText: { color: "#e2e8f0", fontSize: 16, fontWeight: "700" },
});
