import { useEffect, useState } from 'react';

// ── Fake data — includes deliberately long messages to test truncation ──
const MOCK_KUDOS = [
  { sender_name: 'Alex',       receiver_name: 'Jingzhi X.', message: 'Your sunflower field is breathtaking!' },
  { sender_name: 'Bobby',      receiver_name: 'Alex',        message: 'Best farm layout I have ever seen, seriously the symmetry is chef\'s kiss' },
  { sender_name: 'Jingzhi X.', receiver_name: 'Bobby',       message: 'Thanks for the cabbage tips, legend!' },
  { sender_name: 'Alice',      receiver_name: 'Jingzhi X.', message: 'The pelican just vibing there is the most peaceful thing I have seen all week' },
  { sender_name: 'Bobby',      receiver_name: 'Alice',       message: 'Strawberry patch is absolutely massive' },
  { sender_name: 'Alex',       receiver_name: 'Alice',       message: 'Most peaceful farm in the neighborhood' },
  { sender_name: 'Jingzhi X.', receiver_name: 'Alex',        message: 'Watermelon at stage 6 is a work of art' },
  { sender_name: 'Alice',      receiver_name: 'Bobby',       message: 'Capybara placement is genius, 10/10' },
];

// Visual truncation is handled by CSS max-width + mask — full text stays in
// the DOM so hovering the pill can reveal it without a re-render.

export default function KudosBanner() {
  const [kudos, setKudos] = useState(null);

  useEffect(() => {
    fetch('/api/kudos/recent')
      .then(r => r.json())
      .then(data => {
        const items = Array.isArray(data) && data.length > 0 ? data : MOCK_KUDOS;
        setKudos(items);
      })
      .catch(() => setKudos(MOCK_KUDOS));
  }, []);

  if (!kudos) return null;

  // Seamless loop: duplicate so -50% translateX lands back at start
  const doubled = [...kudos, ...kudos];

  // Speed based on total characters across all items — long kudos don't rush,
  // short ones don't crawl. Roughly 1s per 8 chars, min 32s, max 90s.
  const totalChars = kudos.reduce(
    (sum, k) => sum + (k.message?.length ?? 0) + (k.sender_name?.length ?? 0) + (k.receiver_name?.length ?? 0),
    0
  );
  const duration = Math.min(90, Math.max(32, Math.round(totalChars / 7)));

  return (
    <div className="kb-banner" aria-label="Latest kudos from the neighborhood">
      <div className="kb-banner__label" aria-hidden="true">
        <span className="kb-banner__label-star">★</span>
        KUDOS
      </div>

      <div className="kb-banner__track">
        <div
          className="kb-banner__inner"
          style={{ animationDuration: `${duration}s` }}
        >
          {doubled.map((k, i) => (
            <span key={i} className="kb-banner__pill">
              {/* Names row — always full, names are short */}
              <span className="kb-banner__names">
                <span className="kb-banner__from">{k.sender_name}</span>
                <span className="kb-banner__arrow" aria-hidden="true">→</span>
                <span className="kb-banner__to">{k.receiver_name}</span>
              </span>
              {/* Divider */}
              <span className="kb-banner__divider" aria-hidden="true">|</span>
              {/* Message — full text in DOM; CSS collapses + fades it,
                  hover on the pill reveals everything */}
              <span className="kb-banner__msg">{k.message}</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
