const MOBILE_SERVER_SELECTOR_TILT_RADIANS = -2 * Math.PI / 180;

export function mobileServerSelectorPolygon(width: number, height: number, shadowOffset: number) {
  const centerX = width / 2;
  const centerY = height / 2;
  const cosine = Math.cos(MOBILE_SERVER_SELECTOR_TILT_RADIANS);
  const sine = Math.sin(MOBILE_SERVER_SELECTOR_TILT_RADIANS);
  return [
    [shadowOffset, shadowOffset],
    [width + shadowOffset, shadowOffset],
    [width + shadowOffset, height + shadowOffset],
    [shadowOffset, height + shadowOffset],
  ].map(([x, y]) => {
    const deltaX = x - centerX;
    const deltaY = y - centerY;
    const rotatedX = centerX + deltaX * cosine - deltaY * sine;
    const rotatedY = centerY + deltaX * sine + deltaY * cosine;
    return `${rotatedX},${rotatedY}`;
  }).join(" ");
}
