/**
 * iOS Rubber-band / Spring Physics for interactive elements (volume/slider controls)
 * Implements Apple's logarithmic resistance when pulling beyond bounds,
 * followed by an elastic spring bounce-back.
 */
export class ElasticSlider {
  private container: HTMLElement;
  private track: HTMLElement;
  private fill: HTMLElement;
  private thumb: HTMLElement;
  private min: number;
  private max: number;
  private value: number;
  private isDragging: boolean = false;
  private startX: number = 0;
  private currentX: number = 0;
  private trackWidth: number = 0;
  private onChange?: (val: number) => void;

  constructor(
    container: HTMLElement,
    options: {
      min?: number;
      max?: number;
      initial?: number;
      onChange?: (val: number) => void;
    } = {}
  ) {
    this.container = container;
    this.min = options.min ?? 0;
    this.max = options.max ?? 100;
    this.value = options.initial ?? 50;
    this.onChange = options.onChange;

    this.container.classList.add('elastic-slider-wrapper');
    this.container.innerHTML = `
      <div class="elastic-track">
        <div class="elastic-fill"></div>
        <div class="elastic-thumb"></div>
      </div>
    `;

    this.track = this.container.querySelector('.elastic-track') as HTMLElement;
    this.fill = this.container.querySelector('.elastic-fill') as HTMLElement;
    this.thumb = this.container.querySelector('.elastic-thumb') as HTMLElement;

    this.initEvents();
    this.updateVisual(0);
  }

  private initEvents() {
    const onStart = (clientX: number) => {
      this.isDragging = true;
      const rect = this.track.getBoundingClientRect();
      this.trackWidth = rect.width;
      this.startX = clientX;
      this.track.classList.add('active');
      this.fill.style.transition = 'none';
      this.thumb.style.transition = 'none';
      this.track.style.transition = 'none';

      // Immediately set value on click/mousedown
      const relativeX = clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, relativeX / (this.trackWidth || 1)));
      this.value = Math.round(this.min + ratio * (this.max - this.min));
      this.updateVisual(0);
      if (this.onChange) this.onChange(this.value);
    };

    const onMove = (clientX: number) => {
      if (!this.isDragging) return;
      const rect = this.track.getBoundingClientRect();
      const relativeX = clientX - rect.left;
      
      let stretch = 0;
      let clampedVal = 0;

      if (relativeX < 0) {
        // Rubber-band resistance pull left
        stretch = -Math.log10(1 + Math.abs(relativeX) / 15) * 18;
        clampedVal = this.min;
      } else if (relativeX > this.trackWidth) {
        // Rubber-band resistance pull right
        stretch = Math.log10(1 + (relativeX - this.trackWidth) / 15) * 18;
        clampedVal = this.max;
      } else {
        const ratio = relativeX / this.trackWidth;
        clampedVal = this.min + ratio * (this.max - this.min);
      }

      this.value = Math.round(Math.min(Math.max(clampedVal, this.min), this.max));
      this.updateVisual(stretch);
      if (this.onChange) this.onChange(this.value);
    };

    const onEnd = () => {
      if (!this.isDragging) return;
      this.isDragging = false;
      this.track.classList.remove('active');

      // Spring bounce back to normal bounds with iOS timing
      this.track.style.transition = 'transform 0.45s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
      this.fill.style.transition = 'width 0.25s cubic-bezier(0.16, 1, 0.3, 1)';
      this.thumb.style.transition = 'left 0.25s cubic-bezier(0.16, 1, 0.3, 1)';

      this.updateVisual(0);
    };

    this.container.addEventListener('mousedown', (e) => onStart(e.clientX));
    window.addEventListener('mousemove', (e) => onMove(e.clientX));
    window.addEventListener('mouseup', () => onEnd());

    // Touch support for touch screens
    this.container.addEventListener('touchstart', (e) => onStart(e.touches[0].clientX));
    window.addEventListener('touchmove', (e) => onMove(e.touches[0].clientX));
    window.addEventListener('touchend', () => onEnd());
  }

  private updateVisual(stretch: number) {
    const percent = ((this.value - this.min) / (this.max - this.min)) * 100;
    this.fill.style.width = `${percent}%`;
    this.thumb.style.left = `${percent}%`;

    // Apply elastik spring stretch to track
    if (stretch !== 0) {
      const scaleX = 1 + Math.abs(stretch) / 200;
      this.track.style.transform = `translateX(${stretch}px) scaleX(${scaleX})`;
    } else {
      this.track.style.transform = `translateX(0px) scaleX(1)`;
    }
  }

  public setValue(val: number) {
    this.value = Math.min(Math.max(val, this.min), this.max);
    this.updateVisual(0);
  }

  public getValue(): number {
    return this.value;
  }
}
