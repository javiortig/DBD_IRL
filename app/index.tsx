// app/index.tsx
// Multitouch fluido con hovers precisos (pageX/pageY).
// Contenido en flujo normal (sin absolutos) -> sin solapes: Título, Jugadores, Barra, %, Hint/OK.
// Barra visible en Android con composición forzada. Overlay de anillos (pointerEvents: none).
// Histeresis repairing, retención de pista, audio por tramos, completado con loop + notif.
// Orientación bloqueada a landscape.

import { Audio } from "expo-av";
import * as Haptics from "expo-haptics";
import { useKeepAwake } from "expo-keep-awake";
import * as ScreenOrientation from "expo-screen-orientation";
import React, { useEffect, useRef, useState } from "react";
import {
	AppState,
	findNodeHandle,
	GestureResponderEvent,
	Pressable,
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

// ==== Audio ====
const VOL = 0.7;
const XFADE_MS = 160;

const SFX = {
	gen1: require("../assets/sfx/Gen1.wav"),
	gen1Repair: require("../assets/sfx/Gen1_Repairing.wav"),
	gen2: require("../assets/sfx/Gen2.wav"),
	gen2Repair: require("../assets/sfx/Gen2_Repairing.wav"),
	gen3: require("../assets/sfx/Gen3.wav"),
	gen3Repair: require("../assets/sfx/Gen3_Repairing.wav"),
	gen4: require("../assets/sfx/Gen4.wav"),
	gen4Repair: require("../assets/sfx/Gen4_Repairing.wav"),
	completed: require("../assets/sfx/Generator_Completed.wav"),
	completedNotif: require("../assets/sfx/Generator_Completed_Notification.wav"),
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

	// Bloqueo de orientación a horizontal
	useEffect(() => {
		ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => {});
	}, []);

	const [progress, setProgress] = useState(0); // 0..1
	const [playersTouching, setPlayersTouching] = useState(0);
	const [isComplete, setIsComplete] = useState(false);
	const [touchPoints, setTouchPoints] = useState<{ id: number; x: number; y: number }[]>([]);

	const rafRef = useRef<number | null>(null);
	const lastTsRef = useRef<number | null>(null);
	const basePerSecond = 1 / SOLO_SECONDS;

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

	// ======= Layout absoluto del área de motor (para convertir pageX/Y a coords locales) =======
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

	const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

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

	// Progreso
	useEffect(() => {
		const loop = (ts: number) => {
			if (!lastTsRef.current) lastTsRef.current = ts;
			const dt = Math.min(0.1, (ts - lastTsRef.current) / 1000);
			lastTsRef.current = ts;

			setProgress(prev => {
				if (isComplete) return prev;
				const mult = getSpeedMultiplier(playersTouching) * BOOST_PER_EXTRA;
				const rate = basePerSecond * mult;
				const next = Math.min(1, prev + rate * dt);
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

	const reset = async () => {
		setProgress(0);
		setIsComplete(false);
		setRepairingSmooth(false);
		clearRepairingTimers();
		clearTouches();

		try { await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}
		if (currentRef.current) await crossfadeTo(null);
		if (soundsRef.current.completedNotif) {
			await soundsRef.current.completedNotif.stopAsync().catch(() => {});
		}
	};

	useEffect(() => {
		return () => {
			(async () => {
				try {
					clearRepairingTimers();
					if (currentRef.current) {
						await currentRef.current.stopAsync().catch(() => {});
					}
					for (const k of Object.keys(soundsRef.current) as TrackKey[]) {
						await soundsRef.current[k]?.unloadAsync().catch(() => {});
					}
				} catch {}
			})();
		};
	}, []);

	// === Multitouch FLUIDO con pageX/pageY → coords locales del engine ===
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

	const handleGrant = (e: GestureResponderEvent) => updateTouches(e);
	const handleMove = (e: GestureResponderEvent) => updateTouches(e);
	const handleRelease = (e: GestureResponderEvent) => { updateTouches(e); postReleaseDoubleCheck(); };
	const handleTerminate = (_e: GestureResponderEvent) => { clearTouches(); };

	// Limpia toques si la app se va a background/inactiva
	useEffect(() => {
		const sub = AppState.addEventListener("change", (state) => {
			if (state !== "active") {
				clearTouches();
				setRepairingSmooth(false);
				setTimeout(measureEngineInWindow, 0);
			}
		});
		return () => sub.remove();
	}, []);

	const percent = Math.round(progress * 100);

	return (
		<SafeAreaView style={styles.safe}>
			<StatusBar hidden />
			<View style={styles.container}>
				<View
					ref={engineRef}
					style={[styles.engineArea, isComplete && styles.engineComplete]}
					collapsable={false}
					onLayout={measureEngineInWindow}
					pointerEvents={isComplete ? "none" : "auto"}
					onStartShouldSetResponder={() => !isComplete}
					onMoveShouldSetResponder={() => !isComplete}
					onResponderGrant={handleGrant}
					onResponderMove={handleMove}
					onResponderRelease={handleRelease}
					onResponderTerminate={handleTerminate}
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
					{/* --- CAPA 1: Contenido en flujo normal --- */}
					<View style={styles.content} pointerEvents="box-none">
						<Text style={styles.title}>MOTOR</Text>

						{!isComplete && (
							<Text style={styles.players}>
								Jugadores reparando: {playersTouching} / {MAX_PLAYERS}
							</Text>
						)}

						{/* Barra en flujo normal (sin absolutos) */}
						<View
							style={styles.progressBar}
							renderToHardwareTextureAndroid
							needsOffscreenAlphaCompositing
						>
							<View style={[styles.progressFill, { width: `${percent}%` }]} />
						</View>

						{/* % debajo de la barra */}
						<Text style={styles.percent}>{percent}%</Text>

						{isComplete ? (
							<Text style={styles.completeLabel}>¡REPARADO!</Text>
						) : (
							<Text style={styles.hint}>Colocad hasta 4 dedos a la vez</Text>
						)}
					</View>

					{/* --- CAPA 2: Anillos (encima, sin capturar eventos) --- */}
					{!isComplete && (
						<View style={styles.ringsOverlay} pointerEvents="none">
							{touchPoints.map(p => (
								<View key={p.id} style={[styles.touchRing, { left: p.x - 40, top: p.y - 40 }]} />
							))}
						</View>
					)}
				</View>

				<View style={styles.controls}>
					<Pressable style={[styles.button, styles.primary]} onPress={reset}>
						<Text style={styles.buttonText}>Reiniciar</Text>
					</Pressable>
				</View>
			</View>
		</SafeAreaView>
	);
}

// ==== Estilos ====
const styles = StyleSheet.create({
	safe: { flex: 1, backgroundColor: "#0b0e10" },
	container: {
		flex: 1,
		paddingHorizontal: 20,
		paddingVertical: 16,
		backgroundColor: "#0b0e10",
	},
	engineArea: {
		flex: 1,
		borderRadius: 20,
		borderWidth: 2,
		borderColor: "#333",
		backgroundColor: "#12161a",
		alignItems: "center",
		justifyContent: "center",
		position: "relative",
		overflow: "hidden",
		paddingHorizontal: 24, // holgura lateral para landscape
		paddingVertical: 16,   // holgura vertical para que nada se pise
	},
	engineComplete: { borderColor: "#4ade80", backgroundColor: "#122417" },

	// Contenido en flujo normal y con separación vertical consistente
	content: {
		alignItems: "center",
		justifyContent: "center",
		gap: 14,        // separación vertical uniforme entre elementos
		position: "relative",
		zIndex: 1,
		width: "100%",
	},

	title: { color: "#e5e7eb", fontSize: 34, fontWeight: "800", letterSpacing: 2, textAlign: "center" },
	players: { color: "#9ca3af", fontSize: 18, textAlign: "center" },

	// Barra: en flujo normal y con composición forzada (Android)
	progressBar: {
		width: "90%",
		height: BAR_H,
		borderRadius: BAR_R,
		backgroundColor: "#111827",
		borderWidth: 1,
		borderColor: "#374151",
		overflow: "hidden",
		opacity: 0.999, // fuerza composición en Android
		alignSelf: "center",
	},
	progressFill: {
		height: "100%",
		backgroundColor: "#60a5fa",
		borderTopRightRadius: BAR_R,
		borderBottomRightRadius: BAR_R,
	},

	percent: { color: "#e5e7eb", fontSize: 18, fontVariant: ["tabular-nums"], textAlign: "center" },
	completeLabel: { color: "#4ade80", fontSize: 22, fontWeight: "700", textAlign: "center" },
	hint: { color: "#94a3b8", fontSize: 16, textAlign: "center" },

	// Overlay de anillos
	ringsOverlay: {
		position: "absolute",
		left: 0, top: 0, right: 0, bottom: 0,
		zIndex: 2,
	},
	touchRing: {
		position: "absolute",
		width: 80,
		height: 80,
		borderRadius: 40,
		borderWidth: 2,
		borderColor: "#60a5fa",
		backgroundColor: "rgba(96,165,250,0.15)",
		shadowColor: "#60a5fa",
		shadowOpacity: 0.6,
		shadowRadius: 10,
		shadowOffset: { width: 0, height: 0 },
	},

	controls: { flexDirection: "row", gap: 12, justifyContent: "center", marginTop: 12 },
	button: {
		paddingHorizontal: 18,
		paddingVertical: 12,
		borderRadius: 999,
		borderWidth: 1,
	},
	primary: { backgroundColor: "#1f2937", borderColor: "#374151" },
	buttonText: { color: "#e5e7eb", fontSize: 16, fontWeight: "600" },
});
