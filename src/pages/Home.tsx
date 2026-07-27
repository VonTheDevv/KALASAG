import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, Landmark, Network, Satellite, Siren } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import AboutSection from '../components/AboutSection';
import WebsiteLayout from '../components/WebsiteLayout';

const cards = [
  {
    title: 'Multi-Domain Monitoring',
    description: 'Comprehensive real-time tracking across Air, Sea, and Road networks for total situational awareness.',
    icon: Network,
  },
  {
    title: 'Government Integration',
    description: 'Direct data pipelines from PHIVOLCS, PAGASA, and NDRRMC for verified, authoritative disaster reporting.',
    icon: Landmark,
  },
  {
    title: 'Satellite Downlinks',
    description: 'Live global streams and satellite observations keep monitoring views current across multiple information providers.',
    icon: Satellite,
  },
  {
    title: 'Rapid Response',
    description: 'Instant access to emergency hotlines and automated alerts helps reduce response time during a crisis.',
    icon: Siren,
  },
];

export default function Home() {
  const navigate = useNavigate();
  const [activeCardIndex, setActiveCardIndex] = useState(0);
  const [carouselPaused, setCarouselPaused] = useState(false);
  const [hasCarouselInteraction, setHasCarouselInteraction] = useState(false);
  const swipeStartX = useRef<number | null>(null);

  useEffect(() => {
    if (
      carouselPaused
      || hasCarouselInteraction
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) return undefined;

    const interval = window.setInterval(() => {
      if (!document.hidden) setActiveCardIndex(current => (current + 1) % cards.length);
    }, 5_000);

    return () => window.clearInterval(interval);
  }, [carouselPaused, hasCarouselInteraction]);

  const showCard = (index: number) => {
    setHasCarouselInteraction(true);
    setActiveCardIndex((index + cards.length) % cards.length);
  };

  const handleNext = () => showCard(activeCardIndex + 1);
  const handlePrev = () => showCard(activeCardIndex - 1);

  const getCardPosition = (index: number) => {
    const difference = (index - activeCardIndex + cards.length) % cards.length;
    if (difference === 0) return 'active';
    if (difference === 1) return 'next';
    if (difference === cards.length - 1) return 'previous';
    return 'hidden';
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary) return;
    swipeStartX.current = event.clientX;
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (swipeStartX.current === null || !event.isPrimary) return;
    const distance = event.clientX - swipeStartX.current;
    swipeStartX.current = null;
    if (Math.abs(distance) < 38) return;
    if (distance > 0) handlePrev();
    else handleNext();
  };

  return (
    <WebsiteLayout>
      <section className="home-hero relative overflow-hidden bg-[#020617]">
        <div className="home-hero-inner relative z-10 mx-auto max-w-[1200px] px-4 text-center sm:px-6">
          <h1 className="home-hero-title mx-auto max-w-3xl animate-smooth-slide-up font-['Hanken_Grotesk'] font-extrabold leading-[1.12] tracking-[0] text-white">
            National Traffic &amp; Disaster Monitoring Hub
          </h1>
          <p className="home-hero-copy mx-auto max-w-2xl animate-smooth-slide-up font-['Inter'] leading-relaxed text-[#94a3b8] [animation-delay:150ms] fill-mode-both">
            Real-time Philippine air, maritime, and road monitoring with authoritative disaster alerts and immediate access to emergency hotlines.
          </p>

          <div className="home-device-stage relative mx-auto w-full max-w-3xl animate-scale-in select-none [animation-delay:300ms] fill-mode-both">
            <div className="home-device-monitor absolute z-10 flex aspect-[1570/948] flex-col overflow-visible rounded-lg border-[3px] border-[#1e293b] bg-[#0f172a] shadow-[0_20px_40px_-15px_rgb(0,0,0/0.9)]">
              <div className="h-full w-full overflow-hidden rounded-[4px] bg-[#020617]">
                <img
                  alt="KALASAG monitoring dashboard on a desktop display"
                  className="h-full w-full object-contain"
                  src="/home-devices/pc.png"
                  width="1570"
                  height="948"
                  draggable={false}
                />
              </div>
              <div className="absolute -bottom-9 left-1/2 -z-10 h-9 w-16 -translate-x-1/2 rounded-t-lg bg-[#1e293b]" />
              <div className="absolute -bottom-10 left-1/2 -z-10 h-1.5 w-28 -translate-x-1/2 rounded-full bg-[#334155]" />
            </div>

            <div className="home-device-laptop absolute z-20 flex flex-col shadow-[0_15px_30px_-10px_rgb(0,0,0/0.9)]">
              <div className="relative aspect-[1360/874] overflow-hidden rounded-t-lg border-2 border-[#1e293b] bg-[#0f172a]">
                <div className="h-full w-full overflow-hidden bg-[#020617]">
                  <img
                    alt="KALASAG monitoring dashboard on a laptop"
                    className="h-full w-full object-cover"
                    src="/home-devices/laptop.png"
                    width="1360"
                    height="874"
                    draggable={false}
                  />
                </div>
              </div>
              <div className="relative flex h-3 flex-col items-center rounded-b-lg border-x-[1.5px] border-b-[1.5px] border-[#334155] bg-[#1e293b] shadow-lg">
                <div className="absolute -top-0.5 h-0.5 w-full bg-[#0f172a]/50" />
                <div className="mt-0.5 h-1 w-1/4 rounded-sm bg-[#0f172a] opacity-50" />
              </div>
            </div>

            <div className="home-device-tablet absolute z-30 aspect-[718/908] overflow-hidden rounded-lg border-2 border-[#1e293b] bg-[#0f172a] p-1 shadow-[0_15px_30px_-10px_rgb(0,0,0/0.9)]">
              <div className="absolute left-1/2 top-2 z-50 h-1 w-1 -translate-x-1/2 rounded-full bg-[#334155]" />
              <div className="h-full w-full overflow-hidden rounded-[4px] bg-[#020617]">
                <img
                  alt="KALASAG monitoring dashboard on a tablet"
                  className="h-full w-full object-contain"
                  src="/home-devices/tablet.png"
                  width="718"
                  height="908"
                  draggable={false}
                />
              </div>
            </div>

            <div className="home-device-phone absolute z-40 aspect-[406/943] overflow-hidden rounded-xl border-2 border-[#1e293b] bg-[#0f172a] p-1 shadow-[0_12px_24px_-8px_rgb(0,0,0/0.9)]">
              <div className="absolute left-1/2 top-2 z-50 h-1.5 w-6 -translate-x-1/2 rounded-full border border-[#334155]/30 bg-[#020617]" />
              <div className="h-full w-full overflow-hidden rounded-[6px] bg-[#020617]">
                <img
                  alt="KALASAG monitoring dashboard on an Android phone"
                  className="h-full w-full object-contain"
                  src="/home-devices/mobile.png"
                  width="406"
                  height="943"
                  draggable={false}
                />
              </div>
            </div>

            <img src="/typhoon.png" alt="" aria-hidden="true" className="home-typhoon-visual home-typhoon-orbit absolute z-0 object-contain opacity-40 mix-blend-screen" />

            <svg className="absolute inset-0 z-[5] h-full w-full pointer-events-none" viewBox="0 0 800 420" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
              <line x1="45" y1="35" x2="380" y2="190" stroke="rgba(59,130,246,0.22)" strokeWidth="1.2" strokeDasharray="3 5" className="animate-pulse" />
            </svg>

            <svg className="absolute inset-0 z-[15] h-full w-full pointer-events-none" viewBox="0 0 800 420" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
              <path d="M 120 380 Q 280 180 680 90" fill="none" stroke="rgba(96,165,250,0.18)" strokeWidth="1.5" strokeDasharray="4 4" />
              <g>
                <animateMotion dur="12s" repeatCount="indefinite" path="M 120 380 Q 280 180 680 90" rotate="auto" />
                <image href="/airplane.png" x="-24" y="-24" width="48" height="48" />
              </g>
            </svg>

            <div className="home-satellite-visual absolute z-0 flex flex-col items-center pointer-events-none">
              <img src="/satellite.png" className="home-satellite-signal h-full w-full object-contain" alt="" aria-hidden="true" />
              <span className="home-satellite-label font-['JetBrains_Mono'] text-blue-400 opacity-60">TELE-SAT</span>
            </div>

            <img src="/flood.png" alt="" aria-hidden="true" className="home-flood-visual home-alert-beacon absolute z-[35] object-contain pointer-events-none" />
            <img src="/seismic.png" alt="" aria-hidden="true" className="home-seismic-visual home-alert-beacon home-alert-beacon-delayed absolute z-[35] object-contain pointer-events-none" />
          </div>

          <div className="home-hero-action flex justify-center animate-smooth-slide-up [animation-delay:450ms] fill-mode-both">
            <button
              type="button"
              onClick={() => navigate('/app')}
              className="home-launch-button inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-blue-600 px-7 font-['Hanken_Grotesk'] text-[15px] font-bold text-white shadow-[0_0_15px_rgba(59,130,246,0.3)] transition-all duration-300 hover:-translate-y-0.5 hover:bg-blue-500 hover:shadow-[0_0_25px_rgba(59,130,246,0.5)] active:scale-95 sm:min-h-12 sm:px-8 sm:text-[16px]"
            >
              <ExternalLink size={18} aria-hidden="true" />
              Launch Web App
            </button>
          </div>
        </div>
      </section>

      <section className="home-feature-section overflow-x-clip border-y border-[#1e293b]/50 bg-[#020617]">
        <div className="mx-auto max-w-[1200px] px-4 sm:px-6">
          <div className="home-feature-heading mx-auto max-w-xl text-center">
            <h2 className="font-['Hanken_Grotesk'] text-[25px] font-extrabold tracking-[0] text-white sm:text-[28px]">Engineered for Excellence</h2>
            <p className="mt-3 font-['Inter'] text-[14px] leading-6 text-[#94a3b8] sm:text-[15px]">
              Discover the monitoring foundations that keep KALASAG clear, current, and ready to use.
            </p>
          </div>

          <div
            className="home-carousel mx-auto"
            onMouseEnter={() => setCarouselPaused(true)}
            onMouseLeave={() => setCarouselPaused(false)}
            onFocusCapture={() => setCarouselPaused(true)}
            onBlurCapture={event => {
              if (!event.currentTarget.contains(event.relatedTarget)) setCarouselPaused(false);
            }}
          >
            <div
              className="home-carousel-viewport relative mx-auto touch-pan-y select-none"
              role="region"
              aria-roledescription="carousel"
              aria-label="KALASAG monitoring capabilities"
              onPointerDown={handlePointerDown}
              onPointerUp={handlePointerUp}
              onPointerCancel={() => { swipeStartX.current = null; }}
            >
              {cards.map((card, index) => {
                const CardIcon = card.icon;
                const position = getCardPosition(index);
                return (
                  <article
                    key={card.title}
                    data-position={position}
                    aria-hidden={position !== 'active'}
                    aria-label={`${index + 1} of ${cards.length}: ${card.title}`}
                    className="home-carousel-card absolute flex flex-col border border-[#334155]/70 bg-[#1e293b]/95 shadow-2xl"
                  >
                    <CardIcon size={30} strokeWidth={1.8} className="shrink-0 text-blue-500" aria-hidden="true" />
                    <h3 className="mt-4 font-['Hanken_Grotesk'] text-[18px] font-bold leading-6 tracking-[0] text-white">{card.title}</h3>
                    <p className="mt-2 font-['Inter'] text-[13px] leading-[1.65] text-[#a8b4c7] sm:text-[13.5px]">{card.description}</p>
                  </article>
                );
              })}
            </div>

            <div className="home-carousel-controls flex items-center justify-center" aria-label="Carousel controls">
              <button type="button" onClick={handlePrev} className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-[#334155] bg-[#1e293b] text-white transition-colors hover:border-blue-500 hover:bg-blue-600" aria-label="Previous capability" title="Previous capability">
                <ChevronLeft size={21} aria-hidden="true" />
              </button>
              <div className="flex items-center justify-center" role="group" aria-label="Choose a capability">
                {cards.map((card, index) => (
                  <button key={card.title} type="button" onClick={() => showCard(index)} className="group grid h-11 w-11 place-items-center" aria-label={`Show ${card.title}`} aria-current={index === activeCardIndex ? 'true' : undefined}>
                    <span className={`block h-1.5 rounded-full transition-[width,background-color] duration-200 ${index === activeCardIndex ? 'w-5 bg-blue-500' : 'w-1.5 bg-[#475569] group-hover:bg-[#94a3b8]'}`} />
                  </button>
                ))}
              </div>
              <button type="button" onClick={handleNext} className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-[#334155] bg-[#1e293b] text-white transition-colors hover:border-blue-500 hover:bg-blue-600" aria-label="Next capability" title="Next capability">
                <ChevronRight size={21} aria-hidden="true" />
              </button>
            </div>
          </div>
        </div>
      </section>

      <AboutSection />
    </WebsiteLayout>
  );
}
