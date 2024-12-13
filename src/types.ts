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
    maintenanceInterval: number; // in days
    primeTime: number; // in seconds
    cleanTime: number; // in seconds
  };
  serial: {
    baudRate: number;
    vendorIds: string[];
  };
  pattern: {
    offsets: {
      x: number;
      y: number;
    };
    travelDistance: {
      x: number;
      y: number;
    };
    rows: {
      x: number;
      y: number;
    };
  };
}
