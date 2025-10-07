// app/index.tsx
// Motor (80%) + Zona de Patada (20%).
// Indicador visual de REGRESIÓN + chispazos aleatorios (Gen_Spark1..9) cada 5–7s mientras hay regresión y nadie repara.
// Multitouch fluido, audio por tramos, completado con loop+notif, landscape.
// Hover centrado y más grande. Usa pageX/pageY + measureInWindow (versión estable).
// Patada con COOLDOWN global y contador visible + "tick" Gen_Kick.wav cada segundo mientras se mantiene.

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

// ==== Audio ====
const VOL = 0.7;
const XFADE_MS = 160;

// ==== Patada ====
const KICK_HOLD_MS = 3000;      // mantener 3s para patear
const KICK_COOLDOWN_MS = 20000; // cooldown global 20s

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
	kickTick: require("../assets/sfx/Gen_Kick.wav"), // ⬅️ tick cada segundo mientras mantienes
	// Chispazos (sparks) durante regresión
	spark1: require("../assets/sfx/sparks/Gen_Spark1.wav"),
	spark2: require("../assets/sfx/sparks/Gen_Spark2.wav"),
	spark3: require("../assets/sfx/sparks/Gen_Spark3.wav"),
	spark4: require("../assets/sfx/sparks/Gen_Spark4.wav"),
	spark5: require("../assets/sfx/sparks/Gen_Spark5.wav"),
	spark6: require("../assets/sfx/sparks/Gen_Spark6.wav"),
	spark7: require("../assets/sfx/sparks/Gen_Spark7.wav"),
	spark8: require("../assets/sfx/sparks/Gen_Spark8.wav"),
	spark9: require("../assets/sfx/sparks/Gen_Spark9.wav"),
} as const;

type TrackKey = keyof typeof SFX;

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
	const [progress, setProgress] = useState(0); // 0..1
	const [playersTouching, setPlayersTouching] = useState(0);
	const [isComplete, setIsComplete] = useState(false);
	const [touchPoints, setTouchPoints] = useState<{ id: number; x: number; y: number }[]>([]);

	const rafRef = useRef<number | null>(null);
	const lastTsRef = useRef<number | null>(null);

	// === Regresión tras patada ===
	const REGRESSION_SPEED_MULT = 0.5; // 50% de la velocidad base de 1 survivor
	const regressionActiveRef = useRef(false);
	const [regressionActive, setRegressionActive] = useState(false); // para UI
	const regressionRecoverBaselineRef = useRef<number | null>(null);
	const regressionRecoverAmount = 0.05; // +5%

	// Pulso visual mientras hay regresión
	const [regPulse, setRegPulse] = useState(false);
	useEffect(() => {
		if (regressionActive) {
			const id = setInterval(() => setRegPulse(p => !p), 450);
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

	// Histeresis repairing (suaviza flapping)
	const REPAIRING_ON_DELAY_MS = 10;
	const REPAIRING_OFF_DELAY_MS = 10;
	const [repairingSmooth, setRepairingSmooth] = useState(false);
	const onTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const offTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Retención mínima de pista
	const MIN_TRACK_HOLD_MS = 250;
	const lastSwitchRef = useRef(0);

	// Refs para chequeo post-frame
	const lastNativeTouchesCountRef = useRef(0);
	const playersTouchingRef = useRef(0);
	useEffect(() => { playersTouchingRef.current = playersTouching; }, [playersTouching]);

	// ======= Layout absoluto del motor (para convertir pageX/Y a coords locales) =======
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

	// Precarga sonidos (incluye sparks y kickTick)
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

	// --- Progreso + Regresión ---
	useEffect(() => {
		const basePerSecond = 1 / SOLO_SECONDS;
		const loop = (ts: number) => {
			if (!lastTsRef.current) lastTsRef.current = ts;
			const dt = Math.min(0.1, (ts - lastTsRef.current) / 1000);
			lastTsRef.current = ts;

			setProgress(prev => {
				if (isComplete) return prev;

				let next = prev;

				const mult = getSpeedMultiplier(playersTouching) * BOOST_PER_EXTRA;
				const repairRate = basePerSecond * mult;

				const shouldRegress = regressionActiveRef.current && playersTouching === 0;
				const regressRate = basePerSecond * REGRESSION_SPEED_MULT;

				if (shouldRegress) {
					next = Math.max(0, next - regressRate * dt);
				} else {
					next = Math.min(1, next + repairRate * dt);
				}

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

	// ======= Multitouch en motor (izquierda) =======
	const readAllTouches = (evt?: GestureResponderEvent) => {
		const touches = (evt?.nativeEvent as any)?.touches ?? [];
		const { x, y, w, h } = engineRectRef.current;
		const sliced = touches.slice(0, MAX_PLAYERS);

		const points = sliced.map((t: any, idx: number) => {
			// Versión estable: pageX/pageY -> coords locales al engine
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
		setTouchPoints(points);
		setPlayersTouching(points.length);
	};

	const clearTouches = () => {
		setTouchPoints([]);
		setPlayersTouching(0);
		lastNativeTouchesCountRef.current = 0;
	};

	// Chequeo post-frame anti-fantasma
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

	// ==== ZONA DE PATEAR (derecha 20%) ====
	const [kickHold, setKickHold] = useState(0); // 0..1 (barra de mantener)
	const kickAnimatingRef = useRef(false);
	const kickStartTsRef = useRef<number | null>(null);
	const kickRafRef = useRef<number | null>(null);

	// COOLDOWN
	const nextKickAtRef = useRef<number>(0);              // timestamp ms cuando puede patear de nuevo
	const [kickCooldownLeftMs, setKickCooldownLeftMs] = useState(0);

	// "tick" de patada cada segundo mientras se mantiene
	const nextKickTickAtRef = useRef<number | null>(null);

	// ticker ligero para el contador de cooldown
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

	const kickPlayBreak = async () => {
		const s = soundsRef.current.break;
		if (!s) return;
		try {
			await s.setIsLoopingAsync(false);
			await s.setVolumeAsync(VOL);
			await s.setPositionAsync(0);
			await s.playAsync();
		} catch {}
	};

	const kickPlayTick = async () => {
		const s = soundsRef.current.kickTick;
		if (!s) return;
		try {
			await s.setIsLoopingAsync(false);
			await s.setVolumeAsync(VOL);
			await s.setPositionAsync(0);
			await s.playAsync();
		} catch {}
	};

	const isKickOnCooldown = () => {
		return Date.now() < nextKickAtRef.current;
	};

	const onKickStart = () => {
		if (isComplete) return;
		if (isKickOnCooldown()) return; // bloquea si hay cooldown
		if (kickAnimatingRef.current) return;

		kickAnimatingRef.current = true;
		kickStartTsRef.current = Date.now();

		// inicia tick inmediato (segundo 0) y programa los siguientes por tiempo
		nextKickTickAtRef.current = Date.now(); // disparo inmediato

		const step = () => {
			if (!kickAnimatingRef.current) return;

			// si entra cooldown en medio, aborta
			if (isKickOnCooldown()) {
				kickReset();
				return;
			}

			// Reproducir tick si toca (cada 1000 ms)
			if (nextKickTickAtRef.current !== null && Date.now() >= nextKickTickAtRef.current) {
				kickPlayTick().catch(() => {});
				nextKickTickAtRef.current += 1000; // siguiente tick en +1s
			}

			const elapsed = Date.now() - (kickStartTsRef.current ?? Date.now());
			const pct = Math.min(1, elapsed / KICK_HOLD_MS);
			setKickHold(pct);

			if (pct >= 1) {
				// Acción de patada
				kickAnimatingRef.current = false;
				kickRafRef.current = null;
				setKickHold(1);

				// Sonido de rotura
				kickPlayBreak().catch(() => {});

				// Aplicar -20% y activar regresión
				setProgress(prev => Math.max(0, prev - 0.20));
				regressionActiveRef.current = true;
				setRegressionActive(true);
				regressionRecoverBaselineRef.current = null;

				// COOLDOWN de 20s
				nextKickAtRef.current = Date.now() + KICK_COOLDOWN_MS;
				setKickCooldownLeftMs(KICK_COOLDOWN_MS);

				// limpiar barra y resetear estado de tick
				nextKickTickAtRef.current = null;
				setTimeout(() => setKickHold(0), 120);
				return;
			}
			kickRafRef.current = requestAnimationFrame(step);
		};
		kickRafRef.current = requestAnimationFrame(step);
	};

	const onKickEnd = () => {
		// si no completó, cancelar y vaciar la barra
		if (kickAnimatingRef.current) {
			kickReset();
		} else {
			// si completó, ya se vacía arriba
		}
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
		// siguiente disparo entre 5s y 7s
		const delay = 5000 + Math.random() * 2000;
		sparkTimeoutRef.current = setTimeout(async () => {
			// sólo chispa si sigue habiendo regresión y nadie repara
			if (!isComplete && regressionActiveRef.current && playersTouchingRef.current === 0) {
				const idx = 1 + Math.floor(Math.random() * 9); // 1..9
				const key = (`spark${idx}`) as TrackKey;
				const s = soundsRef.current[key];
				if (s) {
					try {
						await s.setIsLoopingAsync(false);
						await s.setVolumeAsync(VOL);
						await s.setPositionAsync(0);
						await s.playAsync();
					} catch {}
				}
			}
			// reprogramar siguiente
			scheduleNextSpark();
		}, delay);
	};

	// Arranca/para el planificador de chispazos al entrar/salir de regresión
	useEffect(() => {
		if (regressionActive) {
			scheduleNextSpark();
		} else {
			clearSparkTimer();
		}
		return () => clearSparkTimer();
	}, [regressionActive]);

	// Limpiezas
	useEffect(() => {
		return () => {
			if (rafRef.current) cancelAnimationFrame(rafRef.current);
			if (kickRafRef.current) cancelAnimationFrame(kickRafRef.current);
			clearSparkTimer();
		};
	}, []);

	// Limpia toques si la app se va a background/inactiva
	useEffect(() => {
		const sub = AppState.addEventListener("change", (state) => {
			if (state !== "active") {
				clearTouches();
				setRepairingSmooth(false);
				kickReset();
				regressionActiveRef.current = false;
				setRegressionActive(false);
				regressionRecoverBaselineRef.current = null;
				clearSparkTimer();
				setTimeout(measureEngineInWindow, 0);
			}
		});
		return () => sub.remove();
	}, []);

	const percent = Math.round(progress * 100);

	// Texto del cooldown
	const cooldownSec = (kickCooldownLeftMs / 1000);
	const cooldownLabel = cooldownSec > 0 ? `${cooldownSec.toFixed(1)}s` : "Listo";
	const kickAreaDisabled = isComplete || cooldownSec > 0;

	return (
		<SafeAreaView style={styles.safe}>
			<StatusBar hidden />
			{/* Layout en fila: motor (80%) + patada (20%) */}
			<View style={styles.row}>
				{/* ===== IZQUIERDA: MOTOR ===== */}
				<View
					ref={engineRef}
					style={[styles.engineArea, isComplete && styles.engineComplete]}
					collapsable={false}
					onLayout={measureEngineInWindow}
					pointerEvents={isComplete ? "none" : "auto"}
					onStartShouldSetResponder={() => !isComplete}
					onMoveShouldSetResponder={() => !isComplete}
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
					{/* Contenido en flujo */}
					<View style={styles.engineContent} pointerEvents="box-none">
						<Text style={styles.title}>MOTOR</Text>

						{/* Badge de regresión */}
						{regressionActive && (
							<View style={styles.regBadge}>
								<Text style={styles.regBadgeText}>REGRESIÓN</Text>
							</View>
						)}

						{!isComplete && (
							<Text style={styles.players}>
								Jugadores reparando: {playersTouching} / {MAX_PLAYERS}
							</Text>
						)}

						{/* Barra con pulso rojo si hay regresión */}
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
							<Text style={styles.hint}>Colocad hasta 4 dedos a la vez</Text>
						)}
					</View>

					{/* Overlay de anillos */}
					{!isComplete && (
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
				</View>

				{/* ===== DERECHA: PATEAR (ASESINO) ===== */}
				<View
					style={[
						styles.kickArea,
						(isComplete || cooldownSec > 0) && styles.kickDisabled,
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
						{cooldownSec > 0 ? `Espera ${cooldownLabel}` : "Mantén 3s"}
					</Text>

					{/* Barra vertical roja de carga */}
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

	// Layout en dos columnas (landscape)
	row: {
		flex: 1,
		flexDirection: "row",
	},

	// ===== Motor (izquierda 80%) =====
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

	// Badge REGRESIÓN
	regBadge: {
		paddingHorizontal: 10,
		paddingVertical: 4,
		borderRadius: 999,
		borderWidth: 1,
		borderColor: "#7f1d1d",
		backgroundColor: "rgba(239, 68, 68, 0.15)",
	},
	regBadgeText: {
		color: "#fca5a5",
		fontSize: 13,
		fontWeight: "800",
		letterSpacing: 1,
	},

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

	// Overlay de anillos (encima de todo, sin interceptar eventos)
	ringsOverlay: {
		position: "absolute",
		left: 0, top: 0, right: 0, bottom: 0,
		zIndex: 2,
	},
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
		transform: [{ translateX: -RING_RADIUS }, { translateY: -RING_RADIUS }],
	},

	// ===== Patada (derecha 20%) =====
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
	kickDisabled: {
		opacity: 0.6,
	},
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
	kickFill: {
		width: "100%",
		backgroundColor: "#ef4444",
	},
});
