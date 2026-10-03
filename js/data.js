'use strict';
/* Static game content: map size, buildings, aircraft, locations, airlines and progression tables.
   Every script on the page shares one global lexical scope, so these constants are visible everywhere. */

const W = 50, H = 34;
const SAVE_KEY = 'skyline-airport-collection-v2';
const LEGACY_KEY = 'skyline-airport-save-v1';
const SETTINGS_KEY = 'skyline-airport-settings';
const SAVE_VERSION = 3;
const AIRPORT_VERSION = 2;
const MAX_PLANES = 25;
const MAX_RANDOM_PLANES = 20;
const MINUTES_PER_SECOND = 3;
const SPEEDS = [0, 1, 2, 5, 10];
const MAX_RANK = 30;

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const k = (x, y) => x + ',' + y;
const fmt = n => Math.round(n).toLocaleString('ru-RU');
const cash = n => (n < 0 ? '−' : '') + '$' + fmt(Math.abs(n));
const signedCash = n => (n >= 0 ? '+' : '') + cash(n);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const pick = list => list[Math.floor(Math.random() * list.length)];

const CATEGORIES = [
  {id: 'airside', label: 'Аэродром'},
  {id: 'passenger', label: 'Пассажиры'},
  {id: 'ops', label: 'Службы'},
  {id: 'commerce', label: 'Коммерция'},
  {id: 'special', label: 'Особые здания'}
];

// w/h describe the unrotated footprint; `rotate` buildings can be turned 90° before construction.
const TYPES = {
  taxi: {name: 'Рулёжная дорожка', icon: '≡', cost: 850, w: 1, h: 1, upkeep: 28, height: .12, cat: 'airside',
    description: 'Соединяет ВПП, гейты и стоянки', detail: 'Улучшение ускоряет руление на 12% за уровень.'},
  runway: {name: 'ВПП', icon: '▱', cost: 45000, w: 13, h: 2, upkeep: 1000, height: .12, cat: 'airside', rotate: true,
    description: 'Полоса 13 клеток, можно повернуть', detail: 'Подключайте рулёжку к углам или торцам полосы. Улучшение ускоряет посадку и взлёт на 15% и повышает пропускную способность.'},
  terminal: {name: 'Терминал', icon: '▤', cost: 27000, w: 6, h: 3, upkeep: 650, height: 1.54, cat: 'passenger', rotate: true,
    description: 'Пассажиры и доход', detail: 'Каждый уровень сверх первого даёт +12% выручки от пассажиров. Гейты работают в радиусе 10 клеток от терминала.'},
  gate: {name: 'Гейт', icon: '⌑', cost: 10000, w: 2, h: 2, upkeep: 310, height: .24, cat: 'passenger',
    description: 'Стоянка у терминала', detail: 'Гейт 2 ур. принимает дальнемагистральные лайнеры. Рядом нужны терминал и рулёжная дорожка.'},
  parking: {name: 'Парковка', icon: 'P', cost: 16000, w: 4, h: 3, upkeep: 140, height: .35, cat: 'commerce', rank: 2, rotate: true,
    description: '+$3 с пассажира за уровень', detail: 'Неавиационный доход: +$3 с каждого вылетевшего пассажира за уровень. Учитывается до 6 уровней парковок.'},
  shops: {name: 'Магазины и кафе', icon: '✦', cost: 19000, w: 3, h: 2, upkeep: 300, height: .95, cat: 'commerce', rank: 3, rotate: true,
    description: '+4% выручки за уровень', detail: 'Работают в радиусе 9 клеток от терминала: +4% выручки за уровень (до +32%) и немного репутации с каждого рейса.'},
  service: {name: 'Службы', icon: '✚', cost: 14500, w: 3, h: 2, upkeep: 420, height: 1.0, cat: 'ops', rotate: true,
    description: 'Ускоряют оборот рейсов', detail: 'Каждый уровень ускоряет обслуживание на 8% (до 55%) и быстрее устраняет задержки.'},
  fuel: {name: 'Топливная база', icon: '◈', cost: 17500, w: 3, h: 2, upkeep: 470, height: 1.0, cat: 'ops', rotate: true,
    description: 'Уменьшает расходы', detail: 'Каждый уровень снижает расходы на рейс на 9% (до 30%).'},
  tower: {name: 'Диспетчерская', icon: '♜', cost: 21000, w: 2, h: 2, upkeep: 460, height: 2.35, cat: 'ops',
    description: 'Снижает задержки', detail: 'Каждый уровень уменьшает вероятность происшествий.'},
  cargo: {name: 'Грузовой терминал', icon: '▣', cost: 38000, w: 4, h: 3, upkeep: 560, height: 1.2, cat: 'ops', rank: 5, rotate: true,
    description: 'Стоянка грузовых самолётов', detail: 'Принимает грузовые рейсы и контракты. Подключите к рулёжной сети; каждый уровень ускоряет разгрузку на 20%.'},
  ferry: {name: 'Паромный причал', icon: '⚓', cost: 24500, w: 3, h: 2, upkeep: 510, height: 1.1, cat: 'special', locale: 'island', rotate: true,
    description: 'Поток пассажиров с острова', detail: 'Каждый уровень увеличивает загрузку рейсов на 10%.'},
  metro: {name: 'Аэроэкспресс', icon: '▥', cost: 35000, w: 3, h: 2, upkeep: 880, height: 1.55, cat: 'special', locale: 'city', rotate: true,
    description: 'Увеличивает выручку рейсов', detail: 'Добавляет 6% выручки с пассажирских рейсов за уровень.'},
  solar: {name: 'Солнечная станция', icon: '☀', cost: 22500, w: 3, h: 2, upkeep: 185, height: .3, cat: 'special', locale: 'desert', rotate: true,
    description: 'Снижает содержание', detail: 'Снижает суточные расходы на 7% за уровень (до 35%).'},
  deicing: {name: 'Антиобледенение', icon: '❄', cost: 26000, w: 3, h: 2, upkeep: 420, height: 1.3, cat: 'special', locale: 'mountain', rotate: true,
    description: 'Спасает расписание в снег', detail: 'В снегопад снижает задержки посадки и обслуживания на 20% за уровень.'}
};

const CLASS = {
  regional: {label: 'Региональный', pax: [28, 74], fee: 105, expense: 58, speed: 1.52, required: 1, service: 25, color: '#f4c977', len: 1.8, span: 1.7},
  narrow: {label: 'Средний', pax: [85, 178], fee: 110, expense: 68, speed: 1.36, required: 1, service: 32, color: '#eaf6ff', len: 2.25, span: 2.15},
  wide: {label: 'Дальний', pax: [188, 310], fee: 125, expense: 75, speed: 1.16, required: 2, service: 43, color: '#b7a9ff', len: 2.7, span: 2.7},
  cargo: {label: 'Грузовой', tons: [16, 44], fee: 540, expense: 320, speed: 1.22, required: 1, service: 38, color: '#e8a860', len: 2.6, span: 2.6, cargo: true}
};

const LOCATIONS = [
  {id: 'main', name: 'Зелёная долина', detail: 'Поля, ровный рельеф и простор для первых маршрутов.',
    boost: 0, demand: 1, flights: 500, contractFlights: 200, onTime: 150, reputation: 85, contracts: 3, runways: 2, gates: 6, special: 'tower',
    sky: [.53, .70, .75], weather: {clear: 5, cloudy: 2.5, rain: 1.7, fog: .8},
    layout: [['runway', 5, 7], ['terminal', 22, 18], ['gate', 20, 15], ['gate', 24, 15], ['gate', 28, 15], ['taxiV', 17, 9, 14], ['taxiH', 14, 18, 31], ['service', 34, 19]]},
  {id: 'island', name: 'Островной хаб', detail: 'Океан, песчаный берег и причалы. Спрос меняется по сезонам, шторма срывают расписание.',
    boost: 35000, demand: 1, season: {period: 7, amp: .2, phase: 0}, flights: 650, contractFlights: 300, onTime: 225, reputation: 88, contracts: 4, runways: 2, gates: 7, special: 'ferry',
    sky: [.38, .67, .83], weather: {clear: 4.5, cloudy: 2, rain: 2, storm: 1.5},
    layout: [['runway', 5, 22], ['terminal', 20, 13], ['gate', 18, 10], ['gate', 22, 10], ['gate', 26, 10], ['taxiV', 17, 9, 21], ['taxiH', 9, 18, 29], ['service', 33, 14]]},
  {id: 'city', name: 'Аэропорт мегаполиса', detail: 'Небоскрёбы вокруг, много деловых пассажиров и дорогой сервис.',
    boost: 55000, demand: 1.15, flights: 950, contractFlights: 480, onTime: 360, reputation: 90, contracts: 5, runways: 3, gates: 9, special: 'metro',
    sky: [.62, .73, .79], weather: {clear: 4, cloudy: 3, rain: 1.5, fog: 1.5},
    layout: [['runway', 4, 5], ['terminal', 21, 21], ['gate', 19, 17], ['gate', 23, 17], ['gate', 27, 17], ['taxiV', 16, 7, 16], ['taxiH', 16, 17, 29], ['service', 34, 23]]},
  {id: 'desert', name: 'Аэропорт в пустыне', detail: 'Жара и длинные маршруты; солнечные станции окупают содержание.',
    boost: 75000, demand: .95, flights: 1250, contractFlights: 640, onTime: 480, reputation: 92, contracts: 5, runways: 3, gates: 11, special: 'solar',
    sky: [.79, .70, .55], weather: {clear: 5.5, heat: 2.5, sand: 2},
    layout: [['runway', 5, 26], ['terminal', 21, 12], ['gate', 19, 10], ['gate', 23, 10], ['gate', 27, 10], ['taxiV', 17, 9, 25], ['taxiH', 9, 18, 29], ['service', 34, 16]]},
  {id: 'mountain', name: 'Горный курорт', detail: 'Вертикальная полоса в долине, снегопады и лыжный сезон. Антиобледенение спасает расписание.',
    boost: 95000, demand: 1.05, season: {period: 9, amp: .25, phase: 1}, flights: 1500, contractFlights: 780, onTime: 560, reputation: 93, contracts: 6, runways: 3, gates: 12, special: 'deicing',
    sky: [.66, .76, .86], weather: {clear: 3.5, cloudy: 2.5, snow: 3, fog: 1},
    layout: [['runway', 6, 8, 1], ['terminal', 21, 14], ['gate', 20, 18], ['gate', 24, 18], ['gate', 28, 18], ['taxiH', 20, 8, 31], ['service', 34, 22]]}
];

const AIRLINES = [
  {id: 'local', code: 'NW', name: 'Северный ветер', kind: 'Региональные', min: 15, gate: 1, terminal: 1, perDay: 5, deadline: 125, pay: .85, cls: 'regional'},
  {id: 'swift', code: 'SL', name: 'SkyLink', kind: 'Бюджетные', min: 35, gate: 1, terminal: 1, perDay: 7, deadline: 105, pay: .94, cls: 'narrow'},
  {id: 'amber', code: 'AM', name: 'Amber Air', kind: 'Регулярные', min: 50, gate: 1, terminal: 1, perDay: 6, deadline: 120, pay: 1.12, cls: 'narrow'},
  {id: 'polar', code: 'PC', name: 'Polar Cargo', kind: 'Грузовые', min: 55, gate: 1, terminal: 0, perDay: 3, deadline: 160, pay: 1.3, cls: 'cargo', cargo: true},
  {id: 'atlas', code: 'AT', name: 'Atlas International', kind: 'Дальние', min: 65, gate: 2, terminal: 2, perDay: 4, deadline: 165, pay: 1.48, cls: 'wide'},
  {id: 'business', code: 'AS', name: 'Astra Business', kind: 'Деловые', min: 75, gate: 2, terminal: 2, perDay: 5, deadline: 110, pay: 1.42, cls: 'narrow'},
  {id: 'premium', code: 'AU', name: 'Aurora First', kind: 'Премиальные', min: 85, gate: 3, terminal: 2, perDay: 4, deadline: 145, pay: 1.80, cls: 'wide'}
];

const SLOTS = [{id: 0, label: 'Ночь · 00–06'}, {id: 1, label: 'Утро · 06–12'}, {id: 2, label: 'День · 12–18'}, {id: 3, label: 'Вечер · 18–24'}];

const GROUPS = [
  {id: 'runways', label: 'ВПП', types: ['runway']},
  {id: 'taxi', label: 'Рулёжные дорожки', types: ['taxi']},
  {id: 'gates', label: 'Гейты и стоянки', types: ['gate', 'cargo']},
  {id: 'terminal', label: 'Терминалы', types: ['terminal']},
  {id: 'commerce', label: 'Коммерция', types: ['parking', 'shops']},
  {id: 'services', label: 'Службы и инфраструктура', types: ['service', 'fuel', 'tower', 'ferry', 'metro', 'solar', 'deicing']}
];

const FEES = {
  low: {label: 'Низкие', text: '−15% выручки, +20% спроса, репутация растёт быстрее', revenue: .85, demand: 1.2, rep: .08},
  standard: {label: 'Обычные', text: 'Сбалансированные аэропортовые сборы', revenue: 1, demand: 1, rep: 0},
  high: {label: 'Высокие', text: '+18% выручки, −15% спроса, репутация снижается', revenue: 1.18, demand: .85, rep: -.12}
};

// approach: landing time multiplier, incident: incident chance multiplier, service: service speed multiplier.
const WEATHER = {
  clear: {name: 'Ясно', icon: '☀', approach: 1, incident: 1},
  cloudy: {name: 'Облачно', icon: '☁', approach: 1.05, incident: 1, dim: .92},
  rain: {name: 'Дождь', icon: '☂', approach: 1.3, incident: 1.15, dim: .82, particles: 'rain', bad: true},
  fog: {name: 'Туман', icon: '≋', approach: 1.6, incident: 1.1, dim: .86, fog: true, bad: true},
  storm: {name: 'Шторм', icon: '⚡', approach: 1.8, incident: 1.4, dim: .68, particles: 'rain', bad: true},
  snow: {name: 'Снегопад', icon: '❄', approach: 1.6, incident: 1.2, dim: .9, particles: 'snow', service: .8, bad: true},
  sand: {name: 'Песчаная буря', icon: '≈', approach: 1.75, incident: 1.3, dim: .8, particles: 'sand', fog: true, bad: true},
  heat: {name: 'Жара', icon: '♨', approach: 1.1, incident: 1.05, service: .9}
};

const PERKS = [
  {id: 'build', icon: '▤', title: 'Типовые проекты', text: '−6% к стоимости строительства и улучшений за уровень.', costs: [1, 2, 3]},
  {id: 'ground', icon: '✚', title: 'Наземные службы', text: '+10% к скорости обслуживания самолётов за уровень.', costs: [1, 2, 2]},
  {id: 'marketing', icon: '☺', title: 'Маркетинг', text: '+7% к пассажирскому спросу за уровень.', costs: [1, 2, 3]},
  {id: 'fuel', icon: '◈', title: 'Топливные контракты', text: '−5% к расходам на рейс за уровень.', costs: [1, 1, 2]},
  {id: 'airline', icon: '✍', title: 'Связи с авиакомпаниями', text: '+6% к оплате контрактных рейсов за уровень.', costs: [2, 2, 3]},
  {id: 'upkeep', icon: '⚙', title: 'Энергоэффективность', text: '−6% к суточному содержанию за уровень.', costs: [1, 2, 2]},
  {id: 'atc', icon: '♜', title: 'Автоматизация УВД', text: '−10% происшествий и +30 мин терпения самолётов в зоне ожидания за уровень.', costs: [2, 3]},
  {id: 'salvage', icon: '⌫', title: 'Демонтаж', text: 'При сносе возвращается 55% стоимости вместо 35%.', costs: [1]},
  {id: 'capital', icon: '$', title: 'Инвесторы', text: '+$30 000 к стартовому капиталу новых аэропортов за уровень.', costs: [1, 2]}
];

const RANK_TITLES = [[1, 'Стажёр'], [2, 'Младший диспетчер'], [4, 'Диспетчер'], [6, 'Начальник смены'], [8, 'Менеджер перрона'], [10, 'Операционный директор'],
  [13, 'Директор аэропорта'], [16, 'Региональный директор'], [20, 'Вице-президент'], [25, 'Президент холдинга'], [30, 'Авиамагнат']];

// `test` receives global stats; the active airport is available as G.
const ACHIEVEMENTS = [
  {id: 'first_flight', icon: '✈', title: 'Первый вылет', text: 'Отправьте первый рейс.', cash: 2000, xp: 10, test: s => s.flights >= 1},
  {id: 'first_contract', icon: '✍', title: 'Первый контракт', text: 'Подпишите контракт с авиакомпанией.', cash: 3000, xp: 15, test: s => s.contractsSigned >= 1},
  {id: 'max_level', icon: '▲', title: 'Максимальный уровень', text: 'Улучшите любую постройку до 3 уровня.', cash: 4000, xp: 20, test: () => G.buildings.some(b => b.level >= 3)},
  {id: 'flights_100', icon: '✈', title: 'Сотня', text: '100 рейсов во всех аэропортах.', cash: 10000, xp: 40, test: s => s.flights >= 100},
  {id: 'pax_10k', icon: '☺', title: 'Поток пассажиров', text: 'Обслужите 10 000 пассажиров.', cash: 15000, xp: 50, test: s => s.pax >= 10000},
  {id: 'night_owl', icon: '☾', title: 'Ночная смена', text: '20 вылетов с 00:00 до 06:00.', cash: 8000, xp: 40, test: s => s.nightFlights >= 20},
  {id: 'storm', icon: '⚡', title: 'Сквозь непогоду', text: '15 посадок в дождь, туман, шторм, снег или бурю.', cash: 12000, xp: 50, test: s => s.badWeatherLandings >= 15},
  {id: 'decisions_10', icon: '⚖', title: 'Решительный директор', text: 'Примите 10 управленческих решений.', cash: 10000, xp: 40, test: s => s.decisions >= 10},
  {id: 'streak_25', icon: '⏱', title: 'Как часы', text: '25 контрактных рейсов вовремя подряд.', cash: 20000, xp: 80, test: s => s.bestStreak >= 25},
  {id: 'runways_3', icon: '▱', title: 'Три полосы', text: '3 рабочие ВПП в одном аэропорту.', cash: 15000, xp: 60, test: () => operationalRunways().length >= 3},
  {id: 'gates_10', icon: '⌑', title: 'Большой перрон', text: '10 рабочих гейтов в одном аэропорту.', cash: 20000, xp: 70, test: () => operationalGates().length >= 10},
  {id: 'airlines_5', icon: '✍', title: 'Желанный партнёр', text: '5 действующих контрактов в одном аэропорту.', cash: 30000, xp: 100, test: () => G.contracts.length >= 5},
  {id: 'cargo_first', icon: '▣', title: 'Груз доставлен', text: 'Отправьте первый грузовой рейс.', cash: 5000, xp: 25, test: s => s.cargoFlights >= 1},
  {id: 'cargo_1000', icon: '▣', title: 'Тысяча тонн', text: 'Перевезите 1000 тонн груза.', cash: 30000, xp: 100, test: s => s.cargoTons >= 1000},
  {id: 'loan_repaid', icon: '⚖', title: 'Чистый баланс', text: 'Полностью погасите кредит.', cash: 5000, xp: 30, test: s => s.loansRepaid >= 1},
  {id: 'rep_95', icon: '★', title: 'Безупречная репутация', text: 'Репутация 95% в любом аэропорту.', cash: 25000, xp: 100, test: () => G.rep >= 95},
  {id: 'second_airport', icon: '◈', title: 'Расширение сети', text: 'Откройте второй аэропорт.', cash: 0, xp: 100, test: () => portfolio.unlocked.length >= 2},
  {id: 'flights_1000', icon: '✈', title: 'Тысяча взлётов', text: '1000 рейсов во всех аэропортах.', cash: 50000, xp: 150, test: s => s.flights >= 1000},
  {id: 'pax_100k', icon: '☺', title: 'Миллион улыбок', text: 'Обслужите 100 000 пассажиров.', cash: 60000, xp: 150, test: s => s.pax >= 100000},
  {id: 'millionaire', icon: '$', title: 'Миллионер', text: 'Баланс $1 000 000 в одном аэропорту.', cash: 0, xp: 120, test: () => G.money >= 1e6},
  {id: 'collection', icon: '♛', title: 'Авиамагнат', text: 'Развейте все аэропорты коллекции на 100%.', cash: 250000, xp: 500, test: () => LOCATIONS.every(l => portfolio.airports[l.id]?.completed)}
];

const STATE_LABELS = {holding: 'В зоне ожидания', approach: 'Заход на посадку', exit_runway: 'Съезжает с ВПП', taxi_in: 'Рулит к стоянке', dock: 'Парковка',
  service: 'Обслуживание', ready: 'Ждёт выруливания', taxi_out: 'Рулит к ВПП', lineup: 'Выход на ВПП', takeoff: 'Взлёт'};
