import { Bodies, Body, Common, type IBodyDefinition, type Vector } from "matter-js";
import decomp from "poly-decomp";
import type { QuarterTurn, ShapeType } from "./types";
import { PIECE_STYLES } from "./pieces";

Common.setDecomp(decomp);

type SvgPoint = readonly [x: number, y: number];

interface SvgGeometry {
  width: number;
  height: number;
  paths: readonly (readonly SvgPoint[])[];
}

interface PiecePlugin {
  shapeType: ShapeType;
  visualOffset: Vector;
}

const MATERIALS: Record<ShapeType, IBodyDefinition> = {
  logo: {
    friction: 0.88,
    frictionStatic: 1,
    restitution: 0.05,
    frictionAir: 0.014,
    density: 0.0018
  },
  petal: {
    friction: 0.72,
    frictionStatic: 0.9,
    restitution: 0.035,
    frictionAir: 0.032,
    density: 0.00072
  },
  origami: {
    friction: 0.76,
    frictionStatic: 0.94,
    restitution: 0.03,
    frictionAir: 0.025,
    density: 0.0009
  },
  lantern: {
    friction: 0.7,
    frictionStatic: 0.9,
    restitution: 0.04,
    frictionAir: 0.024,
    density: 0.001
  },
  butterfly: {
    friction: 0.66,
    frictionStatic: 0.86,
    restitution: 0.035,
    frictionAir: 0.03,
    density: 0.00078
  }
};

/**
 * Simplified outlines measured from each SVG's opaque silhouette. Coordinates
 * remain in the source viewBox so the collider and rendered image share scale.
 */
const SVG_GEOMETRY: Record<ShapeType, SvgGeometry> = {
  logo: {
    width: 220,
    height: 220,
    paths: [[
      [110, 8], [203, 62], [203, 158], [110, 212], [17, 158], [17, 62]
    ]]
  },
  petal: {
    width: 371,
    height: 446,
    paths: [
      [
        [167, 325], [101, 373], [35, 445], [20, 413], [24, 391],
        [277, 209], [291, 180], [288, 147], [266, 111], [218, 71],
        [277, 145], [266, 201], [43, 356], [4, 261], [6, 155],
        [33, 84], [98, 23], [152, 3], [227, 4], [292, 35],
        [347, 89], [368, 139], [368, 188], [317, 257]
      ],
      [
        [179, 410], [97, 399], [182, 337], [309, 331], [364, 306], [293, 376]
      ]
    ]
  },
  origami: {
    width: 622,
    height: 655,
    paths: [[
      [66, 340], [130, 270], [334, 206], [502, 180],
      [506, 558], [490, 576], [154, 546], [130, 512]
    ]]
  },
  lantern: {
    // The replacement lantern.svg uses a 520 x 620 viewBox.
    // Keep this outline in that same coordinate space so the visible bottom
    // of the lantern and its Matter.js support point line up.
    width: 520,
    height: 620,
    paths: [[
      [33, 124], [54, 90], [156, 42], [246, 26], [320, 32],
      [448, 84], [460, 112], [460, 202], [424, 504], [366, 552],
      [305, 588], [234, 588], [168, 562], [102, 508], [50, 274]
    ]]
  },
  butterfly: {
    width: 696,
    height: 696,
    paths: [
      [
        [337, 407], [278, 365], [241, 323], [230, 284], [235, 150],
        [249, 68], [268, 48], [301, 57], [332, 88], [353, 132],
        [370, 209], [377, 287], [370, 350]
      ],
      [
        [331, 433], [344, 330], [373, 221], [421, 113], [455, 86],
        [483, 88], [498, 126], [505, 201], [502, 305], [488, 391],
        [464, 454], [429, 486]
      ],
      [
        [335, 433], [285, 379], [224, 368], [184, 389], [160, 450],
        [168, 531], [184, 586], [221, 608], [258, 590], [300, 535], [348, 479]
      ],
      [
        [335, 439], [431, 454], [414, 516], [364, 572], [308, 622],
        [256, 649], [230, 641], [235, 586], [260, 533], [290, 480]
      ]
    ]
  }
};

function scaleGeometry(type: ShapeType): Vector[][] {
  const geometry = SVG_GEOMETRY[type];
  const displayWidth = PIECE_STYLES[type].renderWidth;
  const scale = displayWidth / geometry.width;

  return geometry.paths.map((path) => path.map(([sourceX, sourceY]) => ({
    x: (sourceX - geometry.width / 2) * scale,
    y: (sourceY - geometry.height / 2) * scale
  })));
}

function polygonMetrics(vertices: readonly Vector[]): { area: number; centroid: Vector } {
  let twiceSignedArea = 0;
  let weightedX = 0;
  let weightedY = 0;

  for (let index = 0; index < vertices.length; index += 1) {
    const current = vertices[index];
    const next = vertices[(index + 1) % vertices.length];
    if (!current || !next) continue; // the loop bounds already exclude this
    const cross = current.x * next.y - next.x * current.y;
    twiceSignedArea += cross;
    weightedX += (current.x + next.x) * cross;
    weightedY += (current.y + next.y) * cross;
  }

  const area = twiceSignedArea / 2;
  return {
    area: Math.abs(area),
    centroid: {
      x: weightedX / (3 * twiceSignedArea),
      y: weightedY / (3 * twiceSignedArea)
    }
  };
}

function getPlugin(body: Body): PiecePlugin {
  return body.plugin as PiecePlugin;
}

function rotateVector(vector: Vector, angle: number): Vector {
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return {
    x: vector.x * cosine - vector.y * sine,
    y: vector.x * sine + vector.y * cosine
  };
}

export function getPieceVisualPosition(body: Body): Vector {
  const offset = rotateVector(getPlugin(body).visualOffset, body.angle);
  return { x: body.position.x + offset.x, y: body.position.y + offset.y };
}

export function setPieceVisualPosition(body: Body, x: number, y: number): void {
  const offset = rotateVector(getPlugin(body).visualOffset, body.angle);
  Body.setPosition(body, { x: x - offset.x, y: y - offset.y });
}

/** Creates a rigid body whose collision parts follow the visible SVG silhouette. */
export function createPhysicsBody(type: ShapeType, x: number, y: number, turn: QuarterTurn): Body {
  const style = PIECE_STYLES[type];
  const vertexSets = scaleGeometry(type);
  const initialPlugin: PiecePlugin = {
    shapeType: type,
    visualOffset: { x: 0, y: 0 }
  };
  const options: IBodyDefinition = {
    ...MATERIALS[type],
    label: `piece:${type}`,
    render: {
      fillStyle: style.fill,
      strokeStyle: style.stroke,
      lineWidth: 4
    },
    plugin: initialPlugin
  };

  const parts = vertexSets.flatMap((vertices) => {
    const { centroid } = polygonMetrics(vertices);
    const pathBody = Bodies.fromVertices(
      centroid.x,
      centroid.y,
      [vertices],
      options,
      true,
      0.01,
      1,
      0.01
    );
    return pathBody.parts.length > 1 ? pathBody.parts.slice(1) : [pathBody];
  });
  const single = parts.length === 1 ? parts[0] : undefined;
  const body = single ?? Body.create({ ...options, parts });
  const visualOffset = { x: -body.position.x, y: -body.position.y };
  body.plugin = { shapeType: type, visualOffset };
  Body.setAngle(body, turn * Math.PI / 2);
  setPieceVisualPosition(body, x, y);
  return body;
}
