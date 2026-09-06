import * as THREE from "three";

function drawingSurface(width: number, height = width) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The turntable needs canvas rendering.");
  return { canvas, context };
}

export function createGrooveTexture() {
  const { canvas, context } = drawingSurface(1024);
  context.fillStyle = "#808080";
  context.fillRect(0, 0, 1024, 1024);
  for (let radius = 185; radius < 510; radius += 1.75) {
    context.beginPath();
    context.arc(512, 512, radius, 0, Math.PI * 2);
    context.strokeStyle = "#454545";
    context.lineWidth = 0.65;
    context.stroke();
  }
  return new THREE.CanvasTexture(canvas);
}

export function createRecordLabel() {
  const { canvas, context } = drawingSurface(1024);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;

  function writeLine(text: string, y: number, size: number, weight = 400) {
    context.font = `${weight} ${size}px Poppins, sans-serif`;
    const width = context.measureText(text).width;
    if (width > 770) context.font = `${weight} ${Math.floor(size * 770 / width)}px Poppins, sans-serif`;
    context.fillText(text, 512, y, 770);
  }

  return {
    texture,
    update(title: string, artist: string) {
      context.fillStyle = "#d884a2";
      context.fillRect(0, 0, 1024, 1024);
      context.strokeStyle = "#a04263";
      context.lineWidth = 3;
      for (const radius of [466, 451, 85]) {
        context.beginPath();
        context.arc(512, 512, radius, 0, Math.PI * 2);
        context.stroke();
      }
      context.fillStyle = "#421828";
      context.textAlign = "center";
      writeLine("octave", 332, 148, 600);
      writeLine("CODE2CREATE  /  ACM-VIT", 394, 25, 500);
      writeLine(title, 678, 34, 500);
      writeLine(artist, 730, 27);
      writeLine("SIDE A  ·  33⅓ RPM", 840, 22, 500);
      texture.needsUpdate = true;
    },
  };
}

/** The event's own artwork, printed onto the physical deck. */
export function createDeckBranding(onChange: () => void) {
  const front = drawingSurface(2048, 256);
  const badge = drawingSurface(512);
  const frontTexture = new THREE.CanvasTexture(front.canvas);
  const badgeTexture = new THREE.CanvasTexture(badge.canvas);
  frontTexture.colorSpace = THREE.SRGBColorSpace;
  badgeTexture.colorSpace = THREE.SRGBColorSpace;
  const wordmark = new Image();
  const acm = new Image();
  let disposed = false;

  function draw() {
    if (disposed) return;
    front.context.clearRect(0, 0, 2048, 256);
    front.context.fillStyle = "#f2d9df";
    front.context.font = "500 126px Poppins, sans-serif";
    if (wordmark.complete && wordmark.naturalWidth > 0) {
      front.context.drawImage(wordmark, 50, 58, 1140, 144);
    } else front.context.fillText("Code2Create", 50, 178);
    front.context.font = "500 68px Poppins, sans-serif";
    front.context.fillText("ACM-VIT", 1580, 156);
    front.context.fillStyle = "#d884a2";
    front.context.fillRect(1390, 66, 2, 122);
    if (acm.complete && acm.naturalWidth > 0) front.context.drawImage(acm, 1440, 77, 102, 102);

    badge.context.clearRect(0, 0, 512, 512);
    if (acm.complete && acm.naturalWidth > 0) badge.context.drawImage(acm, 132, 40, 248, 248);
    badge.context.fillStyle = "#eed1dc";
    badge.context.textAlign = "center";
    badge.context.font = "500 57px Poppins, sans-serif";
    badge.context.fillText("ACM-VIT", 256, 368);
    badge.context.font = "400 20px Poppins, sans-serif";
    badge.context.fillText("STUDENT CHAPTER", 256, 412);
    frontTexture.needsUpdate = true;
    badgeTexture.needsUpdate = true;
    onChange();
  }
  wordmark.addEventListener("load", draw);
  acm.addEventListener("load", draw);
  wordmark.src = "/assets/wordmark.svg";
  acm.src = "/assets/acm-mark.svg";
  // The first draw happens after the scene's render scheduling is initialized.
  queueMicrotask(draw);

  return {
    front: frontTexture,
    badge: badgeTexture,
    dispose() {
      disposed = true;
      wordmark.removeEventListener("load", draw);
      acm.removeEventListener("load", draw);
      frontTexture.dispose();
      badgeTexture.dispose();
    },
  };
}
