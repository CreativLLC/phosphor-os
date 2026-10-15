// CRT HIGH effects on a timer: a short flicker every 5-12 s and one rolling band every 15-30 s.
// Looping CSS animations kept the GPU redrawing the whole screen every frame; this lets it rest.

const rand = (min: number, max: number) => min + Math.random() * (max - min);

function pulse(cls: string, ms: number): void {
  const d = document.documentElement;
  if (d.dataset.crt !== 'high' || document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  d.classList.add(cls);
  setTimeout(() => d.classList.remove(cls), ms);
}

export function startCrt(): void {
  const flick = () => {
    pulse('crt-flick', 260);
    setTimeout(flick, rand(5000, 12000));
  };
  const roll = () => {
    pulse('crt-roll', 3300);
    setTimeout(roll, rand(15000, 30000));
  };
  setTimeout(flick, rand(3000, 8000));
  setTimeout(roll, rand(6000, 14000));
}
