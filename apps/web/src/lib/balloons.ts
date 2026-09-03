export function releaseBalloons() {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  void import("balloons-js")
    .then(({ balloons }) =>
      balloons({
        logoUrls: ["/assets/acm-vit-balloon.png", "/assets/acm-w-balloon.png"],
      }),
    )
    .catch(() => undefined);
}
