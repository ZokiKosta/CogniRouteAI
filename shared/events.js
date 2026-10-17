// Catalog of everything the app can detect: Macedonian labels, the scoring
// category, the penalty used by scoring.js and a short piece of advice.

export const CATEGORIES = {
  smoothness: { label: 'Мазност', icon: '〰️' },
  speed: { label: 'Брзина', icon: '⏱️' },
  distance: { label: 'Растојание и пешаци', icon: '↔️' },
  maneuvers: { label: 'Маневри и правила', icon: '↪️' },
  attention: { label: 'Внимание', icon: '👁️' },
};

export const EVENT_TYPES = {
  harsh_brake: {
    label: 'Нагло кочење',
    category: 'smoothness',
    penalty: 4,
    advice: 'Гледај подалеку напред и почни да кочиш порано и постепено.',
  },
  harsh_accel: {
    label: 'Нагло забрзување',
    category: 'smoothness',
    penalty: 3,
    advice: 'Притискај го гасот постепено – мазното забрзување е побезбедно и штеди гориво.',
  },
  harsh_corner: {
    label: 'Остро свртување',
    category: 'smoothness',
    penalty: 3,
    advice: 'Намали ја брзината пред кривината, а не во неа.',
  },
  speeding: {
    label: 'Пребрзо возење',
    category: 'speed',
    penalty: 4,
    advice: 'Почитувај го ограничувањето – на 50 km/h патот за запирање е околу 25 m, а на 70 km/h над 40 m.',
  },
  tailgating: {
    label: 'Преблиску до возилото напред',
    category: 'distance',
    penalty: 4,
    advice: 'Држи најмалку 2 секунди растојание (3 секунди на мокар пат).',
  },
  pedestrian_alert: {
    label: 'Пешак пред возилото',
    category: 'distance',
    penalty: 0,
    advice: 'Кај пешачки премини намали брзина и биди подготвен да застанеш.',
  },
  solid_line_crossing: {
    label: 'Преминување преку полна линија',
    category: 'maneuvers',
    penalty: 10,
    advice: 'Полната (непрекината) линија не смее да се преминува – почекај испрекината линија за менување лента или претекнување.',
  },
  lane_change_no_blinker: {
    label: 'Менување лента без жмигавец',
    category: 'maneuvers',
    penalty: 5,
    advice: 'Вклучи жмигавец неколку секунди пред да ја смениш лентата.',
  },
  turn_no_blinker: {
    label: 'Свртување без жмигавец',
    category: 'maneuvers',
    penalty: 5,
    advice: 'Вклучи жмигавец навреме пред свртување за другите да знаат што планираш.',
  },
  no_mirror_check: {
    label: 'Маневар без поглед во ретровизор',
    category: 'maneuvers',
    penalty: 5,
    advice: 'Пред секој маневар: ретровизор → жмигавец → мртов агол → маневар.',
  },
  partial_mirror_check: {
    label: 'Непотполна проверка на ретровизори',
    category: 'maneuvers',
    penalty: 1.5,
    advice: 'Погледни и во внатрешниот и во страничниот ретровизор на страната кон која се префрлаш.',
  },
  reverse_no_check: {
    label: 'Рикверц без проверка наназад',
    category: 'maneuvers',
    penalty: 6,
    advice: 'Пред и за време на рикверц погледни во ретровизорите и преку рамо.',
  },
  stop_sign_violation: {
    label: 'Незапирање на знак STOP',
    category: 'maneuvers',
    penalty: 10,
    advice: 'Кај знак STOP мора целосно да застанеш, дури и кога нема никој.',
  },
  phone_use: {
    label: 'Користење на телефонот при возење',
    category: 'attention',
    penalty: 6,
    advice: 'Не допирај го телефонот додека возиш – подеси сè пред да тргнеш.',
  },
  distraction: {
    label: 'Поглед надвор од патот',
    category: 'attention',
    penalty: 5,
    advice: 'Не гледај надолу подолго од секунда – на 50 km/h за 2 секунди поминуваш 28 m „на слепо“.',
  },
  drowsiness: {
    label: 'Знаци на поспаност',
    category: 'attention',
    penalty: 8,
    advice: 'Застани и одмори се 15–20 минути. Кафето не ја заменува паузата.',
  },
  emergency_vehicle: {
    label: 'Возило за итна интервенција (сирена)',
    category: 'distance',
    penalty: 0,
    advice: 'Направи простор: тргни што подесно, намали брзина и не кочи нагло.',
  },
};

export const MANEUVER_TYPES = {
  lane_change: { label: 'Менување лента' },
  turn: { label: 'Свртување' },
  reverse: { label: 'Рикверц' },
};

export const DIRECTION_LABELS = { left: 'лево', right: 'десно' };

const MONTHS = ['јан', 'фев', 'мар', 'апр', 'мај', 'јун', 'јул', 'авг', 'сеп', 'окт', 'ное', 'дек'];
const pad = (n) => String(n).padStart(2, '0');

/** "17 окт" / "17 окт 11:12" – browsers differ in Macedonian locale data, so format by hand. */
export function formatDayMonth(t) {
  const d = new Date(t);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function formatDateTime(t) {
  const d = new Date(t);
  return `${formatDayMonth(t)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function eventLabel(type) {
  return EVENT_TYPES[type]?.label ?? type;
}

let counter = 0;

/** Creates an event record in the shape stored in trips and sent to the server. */
export function makeEvent(type, t, fields = {}) {
  counter = (counter + 1) % 1e6;
  return {
    id: `${t.toString(36)}-${counter.toString(36)}`,
    type,
    t,
    ...fields,
  };
}
