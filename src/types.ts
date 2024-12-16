export interface SystemStatus {
  state: string;
  position: {
    x: number;
    y: number;
  };
  lastCommand: {
    type: string;
    status: string;
    message: string;
  };
}

export interface SystemSettings {
  speeds: {
    front: number;
    right: number;
    back: number;
    left: number;
  };
  maintenance: {
    lastMaintenanceDate: string;
    maintenanceInterval: number;
    primeTime: number;
    cleanTime: number;
  };
  serial: {
    baudRate: number;
    vendorIds: string[];
  };
  pattern: {
    initialOffsets: {
      front: { x: number; y: number };
      right: { x: number; y: number };
      back: { x: number; y: number };
      left: { x: number; y: number };
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
    };
    rows: {
      x: number;
      y: number;
    };
  };
}
