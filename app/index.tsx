// app/index.tsx
// Motor + Patada + Regresión + Chispazos + Audio por tramos + Skillchecks DBD.
// Bloqueos: Explosión(5s), Patada(15s), Abandono(5s). Nunca bloquear si ya está completado.

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
	StatusBar,
	StyleSheet,
	Text,
	UIManager,
	View,
} from "react-native";

// ==== Parámetros del juego ====
const MAX_PLAYERS = 4;
const SOLO_SECONDS = 80;
const BOOST_PER_EXTRA = 1;
const MAX_PLAYER_REPAIR_PENALTY = 0.7;

// ==== Barra ====
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
const KICK_HOLD_MS = 3000;
const KICK_COOLDOWN_MS = 20000;

// ==== Bloqueos ====
const BLOCK_AFTER_EXPLOSION_MS = 5000;
const BLOCK_AFTER_KICK_MS = 15000;
const BLOCK_AFTER_ABANDON_MS = 5000;

const SFX = {
  // Loops de progreso
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

function getSpeedMultiplier(players: number) {
  return Math.pow(players, MAX_PLAYER_REPAIR_PENALTY);
}

async function fadeVolume(sound: Audio.Sound, from: number, to: number, ms: number) {
  const steps = 6;
  const stepTime = Math.max(10, Math.round(ms / steps));
  for (let i = 0; i <= steps; i++) {
    const v = from + (to - from) * (i / steps);
    await sound.setVolumeAsync(v).catch(() => {});
    if (i < steps) await new Promise(r => setTimeout(r, stepTime));
  }
}

export default function Engine() {
  useKeepAwake();

  // Bloqueo landscape
  useEffect(() => {
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => {});
  }, []);

  // Estado principal
  const [progress, setProgress] = useState(0);
  const [playersTouching, setPlayersTouching] = useState(0);
  const [isComplete, setIsComplete] = useState(false);
  const isCompleteRef = useRef(false);
  useEffect(() => { isCompleteRef.current = isComplete; }, [isComplete]);

  const [touchPoints, setTouchPoints] = useState<{ id: number; x: number; y: number }[]>([]);

  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);

  // === Regresión ===
  const REGRESSION_SPEED_MULT = 0.5;
  const regressionActiveRef = useRef(false);
  const [regressionActive, setRegressionActive] = useState(false);
  const regressionRecoverBaselineRef = useRef<number | null>(null);
  const regressionRecoverAmount = 0.05;

  // Pulso visual en regresión
  const [regPulse, setRegPulse] = useState(false);
  useEffect(() => {
    if (regressionActive) {
      const id = setInterval(() => setRegPulse(p => !p), 450);
      return () => clearInterval(id);
    } else {
      setRegPulse(false);
    }
  }, [regressionActive]);

  // ==== BLOQUEOS (con temporizador de UI) ====
  const blockUntilRef = useRef<number>(0);
  const [blockLeftMs, setBlockLeftMs] = useState(0);
  const isBlocked = () => Date.now() < blockUntilRef.current;
  const clearTouchesRef = useRef<null | (() => void)>(null);

  const blockFor = (ms: number) => {
    if (isCompleteRef.current) return; // ⬅️ no bloquear si ya está completo
    blockUntilRef.current = Date.now() + ms;
    setBlockLeftMs(ms);
    clearTouchesRef.current?.(); // corta inputs/hover/cuenta
  };

  // ticker para UI de bloqueo
  useEffect(() => {
    const id = setInterval(() => {
      const left = Math.max(0, blockUntilRef.current - Date.now());
      setBlockLeftMs(left);
    }, 100);
    return () => clearInterval(id);
  }, []);
  const blockLabel = (blockLeftMs / 1000).toFixed(1) + "s";

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

  // ===== Layout del motor =====
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
          if (!mounted) { await sound.unloadAsync(); break; }
          soundsRef.current[key] = sound;
        }
      } catch {}
    })();
    return () => { mounted = false; };
  }, []);

  // === Skill state machine ===
  const [skillState, setSkillState] = useState<SkillState>("NONE");
  const skillStateRef = useRef<SkillState>("NONE");
  useEffect(() => { skillStateRef.current = skillState; }, [skillState]);

  // Timers SEPARADOS
  const skillScheduleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // próxima skill (10–15s tras empezar)
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);       // 1s para soltar
  const aimArmDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);        // 1s de espera
  const aimAppearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);     // 0–5s para mostrar círculo
  const aimDeadlineRef = useRef<ReturnType<typeof setTimeout> | null>(null);        // 1s para acertar círculo

  const clearSkillScheduler = () => {
    if (skillScheduleTimerRef.current) {
      clearTimeout(skillScheduleTimerRef.current);
      skillScheduleTimerRef.current = null;
    }
  };
  const clearSkillPhaseTimers = () => {
    if (releaseTimerRef.current) { clearTimeout(releaseTimerRef.current); releaseTimerRef.current = null; }
    if (aimArmDelayRef.current) { clearTimeout(aimArmDelayRef.current); aimArmDelayRef.current = null; }
    if (aimAppearTimerRef.current) { clearTimeout(aimAppearTimerRef.current); aimAppearTimerRef.current = null; }
    if (aimDeadlineRef.current) { clearTimeout(aimDeadlineRef.current); aimDeadlineRef.current = null; }
  };
  const cancelAllSkillTimers = () => { clearSkillScheduler(); clearSkillPhaseTimers(); };

  // Target de AIM
  const [skillTarget, setSkillTarget] = useState<{ x: number; y: number } | null>(null);
  const skillTargetRef = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => { skillTargetRef.current = skillTarget; }, [skillTarget]);
  const aimHandledRef = useRef(false);

  // PROGRAMACIÓN de skill: 10–15s desde que empiezan a reparar, se resetea si paran
  const scheduleSkillFromStart = () => {
    clearSkillScheduler();
    const delay = 10000 + Math.floor(Math.random() * 5000); // [10s, 15s)
    skillScheduleTimerRef.current = setTimeout(tryStartSkill, delay);
  };

  const tryStartSkill = () => {
    skillScheduleTimerRef.current = null;
    // Comprobar condiciones al disparar
    if (
      !isComplete &&
      !regressionActiveRef.current &&
      !isBlocked() &&
      playersTouchingRef.current > 0 &&
      skillStateRef.current === "NONE"
    ) {
      startSkillReleasePhase().catch(() => {});
    }
    // Si no se puede, no reprogramamos aquí: el flanco de "empezar a reparar" lo hará.
  };

  // Arranque/reset de scheduling según empezar/dejar de reparar y estado
  const prevRepairingRef = useRef(false);
  useEffect(() => {
    const repairingNow = playersTouching > 0 && !isBlocked() && !regressionActive && !isComplete && skillState === "NONE";
    const repairingPrev = prevRepairingRef.current;
    prevRepairingRef.current = repairingNow;

    if (isComplete || regressionActive || isBlocked() || skillState !== "NONE") {
      clearSkillScheduler();
      return;
    }

    // Flanco 0->>reparando: programa 10–15s
    if (!repairingPrev && repairingNow) {
      scheduleSkillFromStart();
      return;
    }

    // Si dejan de reparar: cancelar temporizador
    if (repairingPrev && !repairingNow) {
      clearSkillScheduler();
    }
  }, [playersTouching, regressionActive, isComplete, skillState, blockLeftMs]);

  // --- Progreso + Regresión + FREEZE en Skill ---
  useEffect(() => {
    const basePerSecond = 1 / SOLO_SECONDS;
    const loop = (ts: number) => {
      if (!lastTsRef.current) lastTsRef.current = ts;
      const dt = Math.min(0.1, (ts - lastTsRef.current) / 1000);
      lastTsRef.current = ts;

      setProgress(prev => {
        if (isComplete) return prev;
        if (skillStateRef.current !== "NONE") return prev; // FREEZE durante skill
        if (isBlocked()) return prev; // FREEZE durante bloqueos

        let next = prev;
        const mult = getSpeedMultiplier(playersTouching) * BOOST_PER_EXTRA;
        const repairRate = basePerSecond * mult;

        const shouldRegress = regressionActiveRef.current && playersTouching === 0;
        const regressRate = basePerSecond * REGRESSION_SPEED_MULT;

        if (shouldRegress) next = Math.max(0, next - regressRate * dt);
        else next = Math.min(1, next + repairRate * dt);

        // Si llega a 0%, apagar regresión
        if (next <= 0) {
          regressionActiveRef.current = false;
          setRegressionActive(false);
          regressionRecoverBaselineRef.current = null;
        }

        // Cancelación de regresión cuando reparan +5%
        if (regressionActiveRef.current) {
          if (playersTouching > 0) {
            if (regressionRecoverBaselineRef.current === null) {
              regressionRecoverBaselineRef.current = next;
            } else if (next >= regressionRecoverBaselineRef.current + regressionRecoverAmount) {
              regressionActiveRef.current = false;
              setRegressionActive(false);
              regressionRecoverBaselineRef.current = null;
            }
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

  const triggerComplete = async () => {
    setIsComplete(true);
    clearTouches();
    clearRepairingTimers();
    setRepairingSmooth(false);
    regressionActiveRef.current = false;
    setRegressionActive(false);
    regressionRecoverBaselineRef.current = null;

    // limpia bloqueo al completar
    blockUntilRef.current = 0;
    setBlockLeftMs(0);

    try { await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
    await crossfadeTo("completed");
    // notif
    const s = soundsRef.current.completedNotif;
    if (s) {
      try { await s.setIsLoopingAsync(false); await s.setVolumeAsync(VOL); await s.setPositionAsync(0); await s.playAsync(); } catch {}
    }

    // cancelar skills
    cancelAllSkillTimers();
    setSkillState("NONE");
    setSkillTarget(null);
  };

  // Histeresis repairing
  useEffect(() => {
    if (isComplete) return;

    const raw = playersTouching > 0 && !isBlocked();

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
  }, [playersTouching, repairingSmooth, isComplete, blockLeftMs]);

  const clearRepairingTimers = () => {
    if (onTimerRef.current) { clearTimeout(onTimerRef.current); onTimerRef.current = null; }
    if (offTimerRef.current) { clearTimeout(offTimerRef.current); offTimerRef.current = null; }
  };

  // Elección de pista por tramo
  const chooseLoopTrack = (p: number, repairing: boolean): TrackKey | null => {
    if (p <= 0) return null;
    if (p > 0 && p <= 0.25) return repairing ? "gen1Repair" : "gen1";
    if (p > 0.25 && p <= 0.5) return repairing ? "gen2Repair" : "gen2";
    if (p > 0.5 && p <= 0.75) return repairing ? "gen3Repair" : "gen3";
    if (p > 0.75 && p < 1) return repairing ? "gen4Repair" : "gen4";
    return null;
  };

  // Reaccionar a cambios de progreso/repairing/estado
  useEffect(() => {
    (async () => {
      if (isComplete) {
        if (currentKeyRef.current !== "completed") {
          await crossfadeTo("completed");
        }
        return;
      }
      // Durante bloqueos o skills: mantener pista actual (o silencio)
      if (isBlocked() || skillState !== "NONE") return;

      const desired = chooseLoopTrack(progress, repairingSmooth);
      if (!desired) {
        if (currentRef.current) await crossfadeTo(null);
        return;
      }
      if (desired !== currentKeyRef.current) {
        await crossfadeTo(desired);
      }
    })().catch(() => {});
  }, [progress, repairingSmooth, isComplete, blockLeftMs, skillState]);

  // Crossfade genérico
  const crossfadeTo = async (key: TrackKey | null) => {
    try {
      const now = Date.now();
      if (currentKeyRef.current !== key && now - lastSwitchRef.current < MIN_TRACK_HOLD_MS) {
        return;
      }
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
        await Promise.all([
          fadeVolume(next, 0, VOL, XFADE_MS),
          fadeVolume(current, VOL, 0, XFADE_MS),
        ]);
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

  // ======= Multitouch en motor =======
  const readAllTouches = (evt?: GestureResponderEvent) => {
    const touches = (evt?.nativeEvent as any)?.touches ?? [];
    const { x, y, w, h } = engineRectRef.current;
    const sliced = touches.slice(0, MAX_PLAYERS);
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
  // 1) Reglas de SKILL primero (antes de cualquier early-return que estreche a "NONE")

  // Intento prohibido durante AIM_PENDING: tocar antes de que salga el círculo => explota
  if (skillStateRef.current === "AIM_PENDING" && points.length > 0) {
    handleSkillFail();
  }

  // Intento durante AIM_ACTIVE (una sola vez)
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

  // 2) Ahora sí: si está completo, bloqueado o en alguna fase de skill,
  //    no hagas tracking “normal” de reparaciones / hovers
  if (isComplete || isBlocked() || skillStateRef.current !== "NONE") {
    setTouchPoints([]);
    setPlayersTouching(0);
    lastNativeTouchesCountRef.current = 0;
    return;
  }

  // 3) Tracking normal (sin skills ni bloqueos)
  setTouchPoints(points);
  setPlayersTouching(points.length);
};


  const clearTouches = () => {
    setTouchPoints([]);
    setPlayersTouching(0);
    lastNativeTouchesCountRef.current = 0;
  };
  clearTouchesRef.current = clearTouches;

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
    if (isComplete || isBlocked()) return;
    applyTouches(readAllTouches(evt));
  };

  // ==== BLOQUEO por ABANDONO (5s) ====
  const suppressAbandonUntilRef = useRef(0);
  const appActiveRef = useRef(true);
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      appActiveRef.current = (state === "active");
      if (state !== "active") {
        clearTouches();
        setRepairingSmooth(false);
        kickReset();
        regressionActiveRef.current = false;
        setRegressionActive(false);
        regressionRecoverBaselineRef.current = null;
        clearSparkTimer();
        cancelAllSkillTimers();
        setSkillState("NONE");
        setSkillTarget(null);
        setTimeout(measureEngineInWindow, 0);
      }
    });
    return () => sub.remove();
  }, []);

  const prevTouchingRef = useRef(0);
  useEffect(() => {
    const prev = prevTouchingRef.current;
    prevTouchingRef.current = playersTouching;

    // flanco: de >0 a 0 -> posible bloqueo por abandono
    if (prev > 0 && playersTouching === 0) {
      if (skillStateRef.current !== "NONE") return;                // durante skill no
      if (isBlocked()) return;
      if (!appActiveRef.current) return;
      if (Date.now() < suppressAbandonUntilRef.current) return;
      if (isCompleteRef.current) return;                            // ⬅️ no bloquear si ya está completo
      blockFor(BLOCK_AFTER_ABANDON_MS);
    }
  }, [playersTouching]);

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
      const now = Date.now();
      const left = Math.max(0, nextKickAtRef.current - now);
      setKickCooldownLeftMs(left);
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
        setProgress(prev => Math.max(0, prev - 0.20));
        regressionActiveRef.current = true;
        setRegressionActive(true);
        regressionRecoverBaselineRef.current = null;

        // BLOQUEO 15s + cooldown 20s
        blockFor(BLOCK_AFTER_KICK_MS);
        nextKickAtRef.current = Date.now() + KICK_COOLDOWN_MS;
        setKickCooldownLeftMs(KICK_COOLDOWN_MS);

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
        const key = (`spark${idx}`) as TrackKey;
        playOnce(key).catch(() => {});
      }
      scheduleNextSpark();
    }, delay);
  };
  useEffect(() => {
    if (regressionActive) scheduleNextSpark(); else clearSparkTimer();
    return () => clearSparkTimer();
  }, [regressionActive]);

  // ===== Fases de SKILL =====
  const startSkillReleasePhase = async () => {
    // Bloquear scheduling mientras dura esta skill
    clearSkillScheduler();
    setSkillState("RELEASE");
    setSkillTarget(null);
    aimHandledRef.current = false;

    playOnce("skillCheck").catch(() => {});

    if (releaseTimerRef.current) clearTimeout(releaseTimerRef.current);
    releaseTimerRef.current = setTimeout(() => {
      // Si NO soltaron todos en 1s -> fallo
      if (playersTouchingRef.current > 0) {
        handleSkillFail();
      } else {
        // Pasaron release: espera 1s y arma la aparición del círculo en 0–5s
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
    // Escoge posición aleatoria dentro del motor
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
    setProgress(prev => Math.min(1, prev + 0.05));

    // Evitar bloqueo por "abandono" justo después de la skill
    suppressAbandonUntilRef.current = Date.now() + 1500;

    // Después de éxito, no programamos aquí: los supers dejan de reparar y al volver a poner dedos
    // se programa de nuevo (10–15s) por el flanco de "empezar a reparar".
  };

  const handleSkillFail = () => {
    clearSkillPhaseTimers();
    setSkillState("NONE");
    setSkillTarget(null);
    playOnce("explode").catch(() => {});
    setProgress(prev => Math.max(0, prev - 0.10));
    regressionActiveRef.current = true;
    setRegressionActive(true);
    regressionRecoverBaselineRef.current = null;

    // BLOQUEO por explosión 5s
    blockFor(BLOCK_AFTER_EXPLOSION_MS);

    // No programamos próxima hasta que vuelvan a empezar a reparar.
  };

  const percent = Math.round(progress * 100);

  // Cooldown patada
  const cooldownSec = (kickCooldownLeftMs / 1000);
  const cooldownLabel = cooldownSec > 0 ? `${cooldownSec.toFixed(1)}s` : "Listo";
  const kickAreaDisabled = isComplete || cooldownSec > 0 || skillState !== "NONE" || isBlocked();

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar hidden />
      <View style={styles.row}>
        {/* IZQUIERDA: MOTOR */}
        <View
          ref={engineRef}
          style={[
            styles.engineArea,
            isComplete && styles.engineComplete,
            (skillState !== "NONE" || (isBlocked() && !isComplete)) && styles.engineSkill,
          ]}
          collapsable={false}
          onLayout={measureEngineInWindow}
          pointerEvents={isComplete ? "none" : "auto"}
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
                <Text style={styles.skillBadgeTextDim}>Preparados… ¡no toquéis aún!</Text>
              </View>
            )}
            {skillState === "AIM_ACTIVE" && (
              <View style={styles.skillBadge}>
                <Text style={styles.skillBadgeText}>¡TOCA EL CÍRCULO!</Text>
              </View>
            )}

            {/* Badges simultáneos: BLOQUEADO y/o REGRESIÓN */}
            {!isComplete && isBlocked() && (
              <View style={styles.badgeBlocked}>
                <Text style={styles.badgeBlockedText}>BLOQUEADO {blockLabel}</Text>
              </View>
            )}
            {regressionActive && (
              <View style={styles.regBadge}>
                <Text style={styles.regBadgeText}>REGRESIÓN</Text>
              </View>
            )}

            {!isComplete && !isBlocked() && (
              <Text style={styles.players}>
                Jugadores reparando: {playersTouching} / {MAX_PLAYERS}
              </Text>
            )}

            {/* Barra */}
            <View
              style={[
                styles.progressBar,
                regressionActive && (regPulse ? styles.progressBarRegA : styles.progressBarRegB),
              ]}
              renderToHardwareTextureAndroid
              needsOffscreenAlphaCompositing
            >
              <View style={[styles.progressFill, { width: `${percent}%` }]} />
            </View>

            <Text style={styles.percent}>{percent}%</Text>

            {isComplete ? (
              <Text style={styles.completeLabel}>¡REPARADO!</Text>
            ) : (
              <Text style={styles.hint}>
                {skillState === "NONE"
                  ? (isBlocked() ? "Motor bloqueado…" : "Colocad hasta 4 dedos a la vez")
                  : "Habilidad en curso…"}
              </Text>
            )}
          </View>

          {/* Overlay dedos (no mostrar durante bloqueo/skill/completado) */}
          {!isComplete && !isBlocked() && skillState === "NONE" && (
            <View style={styles.ringsOverlay} pointerEvents="none">
              {touchPoints.map(p => (
                <View
                  key={p.id}
                  style={[
                    styles.touchRing,
                    { left: p.x, top: p.y },
                  ]}
                />
              ))}
            </View>
          )}

          {/* Overlay Círculo Skill (verde amarillento) */}
          {skillState === "AIM_ACTIVE" && skillTarget && (
            <View style={styles.skillOverlay} pointerEvents="none">
              <View
                style={[
                  styles.skillRing,
                  { left: skillTarget.x, top: skillTarget.y },
                ]}
              />
            </View>
          )}
        </View>

        {/* DERECHA: PATEAR */}
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
            {isComplete
              ? "Completado"
              : isBlocked()
                ? `Bloqueado ${blockLabel}`
                : cooldownSec > 0
                  ? `Espera ${cooldownLabel}`
                  : (skillState !== "NONE" ? "Habilidad en curso" : "Mantén 3s")}
          </Text>

          <View style={styles.kickBar}>
            <View style={[styles.kickFill, { height: `${Math.round(kickHold * 100)}%` }]} />
          </View>
        </View>
      </View>
    </SafeAreaView>
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
    backgroundColor: "rgba(239, 68, 68, 0.15)",
  },
  regBadgeText: { color: "#fca5a5", fontSize: 13, fontWeight: "800", letterSpacing: 1 },

  badgeBlocked: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#6b7280",
    backgroundColor: "rgba(156,163,175,0.18)",
  },
  badgeBlockedText: { color: "#e5e7eb", fontSize: 13, fontWeight: "800", letterSpacing: 1 },

  skillBadge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#b45309",
    backgroundColor: "rgba(245, 158, 11, 0.18)",
  },
  skillBadgeText: { color: "#fbbf24", fontSize: 14, fontWeight: "900", letterSpacing: 1 },

  skillBadgeDim: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#6b7280",
    backgroundColor: "rgba(156, 163, 175, 0.15)",
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
  },
  progressFill: {
    height: "100%",
    backgroundColor: "#60a5fa",
    borderTopRightRadius: BAR_R,
    borderBottomRightRadius: BAR_R,
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
    borderColor: "#a3e635", // lime-400
    backgroundColor: "rgba(163,230,53,0.20)",
    shadowColor: "#a3e635",
    shadowOpacity: 0.7,
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
});
