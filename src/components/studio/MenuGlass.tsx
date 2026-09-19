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
                    }}
                    radius={circle ? 999 : 28}
                    optics={{
                        depth: circle ? 0.82 : 0.64,
                        curvature: circle ? 0.3 : 0.2,
                        dispersion: 0.22,
                        strength: circle ? 0.28 : 0.18,
                        frost: 1.5,
                        specular: 0.8,
                        sheen: 0.7,
                        glow: 0.35,
                    }}
                >
                    <span />
                </Glass>
            )}
        </div>
    );
}
