declare module '@homebridge/node-pty-prebuilt-multiarch' {
  export function spawn(
    file: string,
    args: string[],
    opts: { name: string; cols: number; rows: number; env: NodeJS.ProcessEnv },
  ): {
    onData(cb: (data: string) => void): void;
    onExit(cb: (event: { exitCode: number }) => void): void;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(): void;
  };
}
