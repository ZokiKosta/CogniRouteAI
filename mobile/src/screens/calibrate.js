// Calibration while parked: where the driver looks for each mirror (driver
// camera + MediaPipe), and the sound of this car's turn signal (microphone).
import { CALIBRATION_STEPS, GAZE_ZONES, GazeCalibrator } from '../../../shared/gaze.js';
import { BlinkerDetector } from '../../../shared/audio/blinker.js';
import { loadSettings, saveSettings } from '../state.js';
import { attach, openCameras, stopStream } from '../sensors/cameras.js';
import { openMicrophone } from '../sensors/audio.js';
import { DriverVision } from '../vision/driver.js';
import { Voice } from '../voice.js';
import { h, mount, toast } from '../ui.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function renderCalibrate(root, { go }) {
  const s = loadSettings();
  const voice = new Voice({ enabled: s.voice });
  const cleanups = [];

  // --- mirrors -------------------------------------------------------------
  const video = h('video', { class: 'calib-video', muted: true, playsinline: true, hidden: true });
  const prompt = h('p', { class: 'calib-prompt' }, s.gazeCalibration ? 'Ретровизорите се калибрирани ✓ (може повторно).' : 'Седни како при возење, со телефонот во држачот.');
  const progress = h('div', { class: 'steps' }, CALIBRATION_STEPS.map((st) => h('span', { class: 'step', dataset: { zone: st.zone } }, GAZE_ZONES[st.zone])));
  const mirrorBtn = h('button', { class: 'primary' }, 'Калибрирај ретровизори');

  mirrorBtn.addEventListener('click', async () => {
    mirrorBtn.disabled = true;
    voice.unlock();
    let stream = null;
    const vision = new DriverVision();
    try {
      prompt.textContent = 'Се вчитува моделот за лице…';
      stream = (await openCameras('driver')).driver;
      cleanups.push(() => stopStream(stream));
      video.hidden = false;
      await attach(video, stream);
      await vision.init();
      cleanups.push(() => vision.close());
      const cal = new GazeCalibrator();
      let current = null;
      let faceSeen = 0;
      vision.start(video, (features) => {
        if (features) faceSeen++;
        if (current && features) cal.add(current, features);
      });
      for (const step of CALIBRATION_STEPS) {
        const chip = progress.querySelector(`[data-zone="${step.zone}"]`);
        chip.classList.add('active');
        prompt.textContent = step.prompt;
        voice.say(step.prompt, { key: `cal-${step.zone}`, cooldownMs: 0 });
        await sleep(1600); // time to move the eyes there
        current = step.zone;
        await sleep(2200);
        current = null;
        chip.classList.remove('active');
        chip.classList.add(cal.count(step.zone) >= 8 ? 'done' : 'failed');
      }
      vision.stop();
      const result = cal.result();
      if (!faceSeen) throw new Error('Не се гледа лице – провери ја камерата кон возачот.');
      if (!result) throw new Error('Некои погледи не се снимени доволно. Обиди се повторно, со главата во кадарот.');
      saveSettings({ gazeCalibration: result });
      prompt.textContent = 'Готово! Ретровизорите се калибрирани ✓';
      voice.say('Готово.', { key: 'cal-done', cooldownMs: 0 });
    } catch (err) {
      prompt.textContent = err.message;
      toast(err.message, 'warn');
    } finally {
      vision.stop();
      stopStream(stream);
      mirrorBtn.disabled = false;
    }
  });

  // --- turn signal ---------------------------------------------------------
  const blinkerStatus = h('p', {}, s.blinkerTemplate ? `Мигавецот е снимен ✓ (${Math.round(60000 / s.blinkerTemplate.periodMs / (s.blinkerTemplate.periodMs < 450 ? 2 : 1))} трепкања во минута).` : 'Вклучи го мигавецот (може и сите четири), па притисни „Слушај“.');
  const blinkerBtn = h('button', { class: 'primary' }, 'Слушај мигавец (8 s)');
  blinkerBtn.addEventListener('click', async () => {
    blinkerBtn.disabled = true;
    let mic = null;
    let ctx = null;
    try {
      mic = await openMicrophone();
      ctx = new AudioContext();
      await ctx.audioWorklet.addModule('/audio-capture.worklet.js');
      const det = new BlinkerDetector(ctx.sampleRate);
      det.startCalibration();
      const src = ctx.createMediaStreamSource(mic);
      const node = new AudioWorkletNode(ctx, 'capture');
      const mute = ctx.createGain();
      mute.gain.value = 0;
      node.port.onmessage = (e) => det.process(e.data, Date.now());
      src.connect(node);
      node.connect(mute).connect(ctx.destination);
      await ctx.resume();
      for (let i = 8; i > 0; i--) {
        blinkerStatus.textContent = `Слушам… ${i}`;
        await sleep(1000);
      }
      const template = det.finishCalibration();
      if (!template) throw new Error('Не го слушнав мигавецот. Намали ја музиката и стави го телефонот поблиску.');
      saveSettings({ blinkerTemplate: template });
      blinkerStatus.textContent = `Снимено ✓ – ритам на кликање ${template.periodMs} ms.`;
    } catch (err) {
      blinkerStatus.textContent = err.message;
    } finally {
      ctx?.close();
      stopStream(mic);
      blinkerBtn.disabled = false;
    }
  });

  mount(
    root,
    h('header', { class: 'topbar' }, h('button', { class: 'icon-btn', 'aria-label': 'Назад', onClick: () => go('/') }, '‹'), h('h1', {}, 'Калибрација')),
    h(
      'main',
      { class: 'calibrate' },
      h(
        'section',
        { class: 'card' },
        h('h2', {}, '👀 Ретровизори'),
        h('p', { class: 'muted' }, 'Апликацијата учи каде гледаш кога ги проверуваш ретровизорите, за да знае дали погледнуваш пред менување лента, свртување и рикверц. Трае околу 20 секунди, само со застанато возило.'),
        video,
        progress,
        prompt,
        mirrorBtn,
        s.gazeCalibration ? h('button', { class: 'link', onClick: () => (saveSettings({ gazeCalibration: null }), toast('Калибрацијата е избришана.')) }, 'Избриши калибрација') : null,
      ),
      h(
        'section',
        { class: 'card' },
        h('h2', {}, '🎧 Звук на мигавецот'),
        h('p', { class: 'muted' }, 'Секој автомобил клика различно. Кога апликацијата го знае звукот на твојот мигавец, полесно го разликува од музика.'),
        blinkerStatus,
        blinkerBtn,
      ),
      h('button', { onClick: () => go('/') }, 'Готово'),
    ),
  );

  return () => cleanups.forEach((fn) => fn());
}
