// Vehicle specification and driving-model presets.

export const SPORTS_CAR = {
  name: 'Meridian GT',
  mass: 1480,
  com: { x: 0, y: 0.42, z: 0.08 },
  inertia: { x: 2350, y: 2650, z: 640 },
  wheelRadius: 0.345,
  wheelWidth: 0.27,
  mountY: 0.6,            // suspension top mount height above body origin
  restLength: 0.33,
  wheels: [
    { x: 0.82, z: 1.33, front: true },   // front left (+x is the car's left)
    { x: -0.82, z: 1.33, front: true },  // front right
    { x: 0.82, z: -1.29, front: false }, // rear left
    { x: -0.82, z: -1.29, front: false },// rear right
  ],
  springFront: 54000, springRear: 50000,
  bumpDamp: 3600, reboundDamp: 4600,
  antiRollFront: 22000, antiRollRear: 14000,
  rollCenter: 0.22,       // tyre forces are applied this far above the contact patch
  engine: {
    idle: 900, redline: 7600, limiter: 7900,
    torque: [[0, 300], [1000, 390], [2000, 470], [3000, 545], [4200, 620], [5600, 610], [6600, 570], [7600, 500], [8000, 420]],
    engineBrake: 70,
  },
  gears: [3.36, 2.24, 1.68, 1.32, 1.07, 0.88, 0.74],
  reverseGear: 3.2,
  finalDrive: 3.55,
  drivetrainEff: 0.88,
  shiftTime: 0.22,
  brakeForce: 17000,      // total, N
  brakeBias: 0.64,
  handbrakeForce: 6500,
  cdA: 0.70,
  downforce: 0.55,        // N per (m/s)^2
  tire: { B: 9.5, C: 1.55 },
};

export const DRIVING_PRESETS = {
  arcade: {
    label: 'Arcade',
    grip: 1.32, rearGrip: 1.0, tcs: 0.85, abs: true, stability: 0.85, countersteer: 0.55,
    maxSteerLow: 36, maxSteerHigh: 10, steerSpeedRef: 42,
    handbrakeGrip: 0.42, powerMul: 1.12, extraDownforce: 1.6, driftSustain: 0.35,
    // drift assist: 1 = full. driftAngle: slip angle reached at full steering (rad); gripSlip: slip allowed
    // while not drifting before the car is pulled straight; driftPush: speed kept up while sliding (m/s²)
    driftAssist: 1, driftAngle: 0.62, gripSlip: 0.09, driftPush: 4.5,
  },
  balanced: {
    label: 'Balanced',
    grip: 1.22, rearGrip: 1.08, tcs: 0.85, abs: true, stability: 0.72, countersteer: 0.45,
    maxSteerLow: 32, maxSteerHigh: 4, steerSpeedRef: 29, lateralAcceleration: 10.5,
    handbrakeGrip: 0.45, powerMul: 1.0, extraDownforce: 1.0, driftSustain: 0.15,
    driftAssist: 0.85, driftAngle: 0.55, gripSlip: 0.1, driftPush: 3.5,
  },
  simulation: {
    label: 'Simulation',
    grip: 1.0, rearGrip: 1.08, tcs: 0, abs: false, stability: 0, countersteer: 0,
    maxSteerLow: 32, maxSteerHigh: 6, steerSpeedRef: 50,
    handbrakeGrip: 0.5, powerMul: 1.0, extraDownforce: 1.0, driftSustain: 0,
  },
};
