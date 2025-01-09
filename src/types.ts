export enum SystemStatus {
  IDLE = "IDLE",
  HOMING_X = "HOMING_X",
  HOMING_Y = "HOMING_Y",
  HOMING_ROTATION = "HOMING_ROTATION",
  HOMED = "HOMED",
  STOPPED = "STOPPED",
  PAUSED = "PAUSED",
  EXECUTING_PATTERN = "EXECUTING_PATTERN",
  ERROR = "ERROR",
  CYCLE_COMPLETE = "CYCLE_COMPLETE",
  CLEANING = "CLEANING",
  PAINTING_SIDE = "PAINTING_SIDE",
  MANUAL_ROTATING = "MANUAL_ROTATING",
  UNKNOWN = "UNKNOWN",
}

export interface SystemSettings {
  speeds: {
    front: number;
    right: number;
    back: number;
    left: number;
    lip: number;
  };
  maintenance: {
    lastMaintenanceDate: string;
    maintenanceInterval: number;
    primeTime: number;
    cleanTime: number;
    backWashTime: number;
    pressurePotDelay: number;
  };
  serial: {
    baudRate: number;
    vendorIds: string[];
    commonPaths: string[];
  };
  pattern: {
    initialOffsets: {
      front: { x: number; y: number; angle: number };
      right: { x: number; y: number; angle: number };
      back: { x: number; y: number; angle: number };
      left: { x: number; y: number; angle: number };
      lip: { x: number; y: number; angle: number };
    };
    travelDistance: {
      horizontal: {
        x: number;
        y: number;
      };
      vertical: {
        x: number;
        y: number;
      };
      lip: {
        x: number;
        y: number;
      };
    };
    rows: {
      x: number;
      y: number;
    };
    enabledSides: {
      front: boolean;
      right: boolean;
      back: boolean;
      left: boolean;
      lip: boolean;
    };
  };
}

export class SerialPortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SerialPortError";
  }
}

export class WebSocketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebSocketError";
  }
}

interface PatternStatus {
  command: number;
  total_commands: number;
  row: number;
  total_rows: number;
  pattern: string;
  single_side: boolean;
  details?: string;
  completed_rows: number[];
  duration: number;
  axis?: "X" | "Y";
}

export interface WebSocketCommand {
  type: string;
  payload?: {
    [key: string]: any;  // Could be more specific based on command types
  };
}

export interface MaintenanceSettings {
  lastMaintenanceDate: string;
  maintenanceInterval: number;
  primeTime: number;
  cleanTime: number;
  backWashTime: number;
  pressurePotDelay: number;
}
