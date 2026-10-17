// Everything the app says out loud, keyed so each phrase can be pre-recorded
// with a Macedonian voice (scripts/generate-voice.js -> public/voice/mk/).
import { CALIBRATION_STEPS } from './gaze.js';

export const LIMITS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130];

export const PHRASES = {
  // events, said once they are detected
  harsh_brake: 'Нагло кочење. Гледај подалеку напред.',
  harsh_accel: 'Нежно со гасот.',
  harsh_corner: 'Намали брзина пред кривина.',
  solid_line_crossing: 'Полна линија! Не смее да се преминува.',
  lane_change_no_blinker: 'Мигавец пред менување лента.',
  turn_no_blinker: 'Мигавец пред свртување.',
  no_mirror_check: 'Погледни во ретровизор пред маневар.',
  reverse_no_check: 'При рикверц гледај назад.',
  stop_sign_violation: 'Кај знак стоп мора целосно да застанеш.',
  phone_use: 'Не користи телефон додека возиш.',
  // live warnings
  tailgating: 'Држи растојание, најмалку две секунди.',
  collision: 'Внимание! Возило напред!',
  pedestrian: 'Внимание, пешак!',
  animal: 'Внимание, животно на патот!',
  siren: 'Возило за итна помош! Тргни десно и направи простор.',
  distraction: 'Гледај на патот!',
  drowsy: 'Изгледаш поспано. Направи пауза.',
  break: 'Време е за кратка пауза.',
  // start / end
  start: 'Среќен пат. Возиме заедно.',
  start_demo: 'Демото започна.',
  end: 'Крај на возењето. Погледни го резимето.',
  // calibration
  ...Object.fromEntries(CALIBRATION_STEPS.map((s) => [`cal-${s.zone}`, s.prompt])),
  'cal-done': 'Готово.',
  // speeding, one per common limit
  ...Object.fromEntries(LIMITS.map((l) => [`speeding_${l}`, `Намали брзина. Ограничување ${l}.`])),
  // green wave (GLOSA): advised speed, one per 5 km/h step
  green_keep: 'Задржи ја брзината за зелен бран.',
  green_ease: 'Тргни ногата од гас, следниот семафор е црвен.',
  green_go: 'Фаќаш зелено, продолжи рамномерно.',
  ...Object.fromEntries(
    Array.from({ length: 16 }, (_, i) => (i + 4) * 5).flatMap((v) => [
      [`green_slow_${v}`, `Намали на ${v} за зелен бран.`],
      [`green_speed_${v}`, `Забрзај до ${v} за да фатиш зелено.`],
    ]),
  ),
};

/** Key + text for the speeding warning at a given limit. */
export function speedingPhrase(limit) {
  const key = `speeding_${limit}`;
  return { key, text: PHRASES[key] ?? `Намали брзина. Ограничување ${limit}.` };
}
