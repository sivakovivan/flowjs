'use client';

import { useEffect, useState } from 'react';
import { Glass } from '@samasante/liquid-glass';

/** Decorative only: native buttons and dialog retain their semantics and focus. */
export function MenuGlass({ circle = false }: { circle?: boolean }) {
    const [enabled, setEnabled] = useState(false);
    useEffect(() => {
        // Upstream reads navigator during render, so only mount in the browser.
        const preference = matchMedia(
            '(prefers-reduced-transparency: reduce), (forced-colors: active)'
        );
        const update = () => setEnabled(!preference.matches);
        update();
        preference.addEventListener('change', update);
        return () => preference.removeEventListener('change', update);
    }, []);
    return (
        <div className="flow-menu__material" aria-hidden="true">
            {enabled && (
                <Glass
                    className="flow-menu__lens"
                    style={{
                        position: 'absolute',
                        inset: 0,
                        width: '100%',
                        height: '100%',
                        background: 'transparent',
                        boxShadow: 'none',
                    }}
                    radius={circle ? 999 : 28}
                    optics={{
                        depth: circle ? 0.56 : 0.42,
                        curvature: circle ? 0.18 : 0.12,
                        dispersion: 0.16,
                        strength: circle ? 0.2 : 0.12,
                        frost: circle ? 0.28 : 0.72,
                        brightness: circle ? 0.08 : 0.16,
                        specular: 0.3,
                        sheen: 0.2,
                        glow: 0.05,
                    }}
                >
                    <span />
                </Glass>
            )}
        </div>
    );
}
