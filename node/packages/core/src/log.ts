import pino, { type DestinationStream, type Logger } from "pino";

export type AppLogger = Logger;

export function createLogger(
  level = process.env.LOG_LEVEL ?? "info",
  destination?: DestinationStream,
): AppLogger {
  const options = {
    level,
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: { error: pino.stdSerializers.err },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}
