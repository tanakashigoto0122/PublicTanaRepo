// からくり装置の物理の世界を作る。cannon-es は引数で受け取る（ページからも、Node での確かめからも使えるように）。
import { BALL_RADIUS, BOARD, GOAL_WALL, PART_TYPES } from './logic.js';

const DEPTH = 0.3;

export function buildWorld(CANNON, stage, placed) {
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
  world.solver.iterations = 20;
  const materials = {
    ball: new CANNON.Material('ball'),
    solid: new CANNON.Material('solid'),
    domino: new CANNON.Material('domino'),
    spring: new CANNON.Material('spring'),
  };
  world.defaultContactMaterial.friction = 0.4;
  world.defaultContactMaterial.restitution = 0.2;
  world.addContactMaterial(new CANNON.ContactMaterial(materials.ball, materials.solid, { friction: 0.3, restitution: 0.3 }));
  world.addContactMaterial(new CANNON.ContactMaterial(materials.ball, materials.domino, { friction: 0.2, restitution: 0.2 }));
  // ドミノどうしは滑らせる（摩擦があると、倒れたドミノが次のドミノに引っかかって止まる）
  world.addContactMaterial(new CANNON.ContactMaterial(materials.domino, materials.domino, { friction: 0, restitution: 0.1 }));
  world.addContactMaterial(new CANNON.ContactMaterial(materials.ball, materials.spring, { friction: 0.2, restitution: 1.05 }));
  world.addContactMaterial(new CANNON.ContactMaterial(materials.domino, materials.spring, { friction: 0.2, restitution: 0.9 }));

  const flat = (body) => {
    body.linearFactor = new CANNON.Vec3(1, 1, 0);
    body.angularFactor = new CANNON.Vec3(0, 0, 1);
    return body;
  };
  const box = ({ x, y, w, h, angle = 0 }, { mass = 0, material = materials.solid } = {}) => {
    const body = new CANNON.Body({ mass, material, shape: new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, DEPTH)) });
    body.position.set(x, y, 0);
    body.quaternion.setFromEuler(0, 0, angle);
    world.addBody(mass > 0 ? flat(body) : body);
    return body;
  };

  // 床と左右の壁
  box({ x: BOARD.width / 2, y: -0.25, w: BOARD.width + 2, h: 0.5 });
  box({ x: -0.25, y: BOARD.height, w: 0.5, h: BOARD.height * 2 });
  box({ x: BOARD.width + 0.25, y: BOARD.height, w: 0.5, h: BOARD.height * 2 });

  const balls = [];
  const goals = [];
  const moving = [];
  for (const item of stage.fixed) {
    if (item.type === 'ball') {
      // light の玉（軽い玉）は、シーソーで飛ばしやすい
      const body = flat(new CANNON.Body({ mass: item.light ? 0.2 : 1, material: materials.ball, shape: new CANNON.Sphere(BALL_RADIUS), angularDamping: 0.1 }));
      body.position.set(item.x, item.y, 0);
      body.item = item;
      world.addBody(body);
      balls.push(body);
    } else if (item.type === 'goal') {
      box({ x: item.x, y: item.y + 0.05, w: item.w, h: 0.1 });
      box({ x: item.x - item.w / 2, y: item.y + GOAL_WALL / 2, w: 0.1, h: GOAL_WALL });
      box({ x: item.x + item.w / 2, y: item.y + GOAL_WALL / 2, w: 0.1, h: GOAL_WALL });
      goals.push(item);
    } else if (item.type === 'seesaw') {
      const pivot = new CANNON.Body({ mass: 0 });
      pivot.position.set(item.x, item.y, 0);
      world.addBody(pivot);
      // 支点の台
      box({ x: item.x, y: item.y / 2 - 0.05, w: 0.3, h: item.y - 0.1 });
      const plank = box({ x: item.x, y: item.y + 0.08, w: item.w, h: 0.12 }, { mass: 0.4 });
      // 右の端に、玉が転がり落ちないための縁
      plank.addShape(new CANNON.Box(new CANNON.Vec3(0.05, 0.15, DEPTH)), new CANNON.Vec3(item.w / 2 - 0.05, 0.2, 0));
      world.addConstraint(new CANNON.HingeConstraint(pivot, plank, {
        pivotA: new CANNON.Vec3(0, 0, 0), axisA: new CANNON.Vec3(0, 0, 1),
        pivotB: new CANNON.Vec3(0, -0.08, 0), axisB: new CANNON.Vec3(0, 0, 1),
      }));
      moving.push({ body: plank, item });
    } else if (item.type === 'ledge') {
      box(item);
    } else if (PART_TYPES[item.type]) {
      moving.push(...addPart(item));
    }
  }
  function addPart(part) {
    const type = PART_TYPES[part.type];
    if (type.dynamic) {
      const body = box(part, { mass: 0.4, material: materials.domino });
      return [{ body, item: part }];
    }
    box(part, { material: type.bouncy ? materials.spring : materials.solid });
    return [];
  }
  for (const part of placed) moving.push(...addPart(part));
  return { world, balls, goals, moving };
}
