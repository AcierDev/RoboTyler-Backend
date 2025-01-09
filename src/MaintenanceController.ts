import { SerialPort } from "serialport";
import { SettingsManager } from "./SettingsManager.js";

export class MaintenanceController {
  private pressurePotActive: boolean = false;
  private pressurePotActivationTime: number = 0;
  private queuedCommand: any = null;
  private queueTimeout: NodeJS.Timeout | null = null;

  constructor(private serialPort: SerialPort) {}

  isPressurePotActive(): boolean {
    return this.pressurePotActive;
  }

  getPressurePotActiveTime(): number {
    if (!this.pressurePotActive) return 0;
    return Date.now() - this.pressurePotActivationTime;
  }

  togglePressurePot(): void {
    this.pressurePotActive = !this.pressurePotActive;
    if (this.pressurePotActive) {
      this.pressurePotActivationTime = Date.now();
    }
    // Send command to toggle pressure pot
    this.serialPort.write("PRESSURE\n");
  }

  queueDelayedCommand(command: any): void {
    this.queuedCommand = command;
    if (this.queueTimeout) {
      clearTimeout(this.queueTimeout);
    }
    
    // Get the current pressure pot delay setting
    const settings = SettingsManager.getInstance();
    const pressurePotDelay = settings.getMaintenanceSettings().pressurePotDelay ?? 5;
    
    this.queueTimeout = setTimeout(() => {
      if (this.queuedCommand) {
        this.serialPort.write(this.queuedCommand + "\n");
        this.queuedCommand = null;
      }
    }, pressurePotDelay * 1000);
  }

  clearQueuedCommand(): void {
    this.queuedCommand = null;
    if (this.queueTimeout) {
      clearTimeout(this.queueTimeout);
      this.queueTimeout = null;
    }
  }
} 