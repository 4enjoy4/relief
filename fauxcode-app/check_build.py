"""Check output files before spending time packaging the application."""
from pathlib import Path
import sys


def main():
    folder = Path(__file__).resolve().parent
    blocked = []
    for target in (folder / 'dist' / 'FauxCode.exe', folder.parent / 'FauxCode.exe'):
        if not target.exists():
            continue
        try:
            # Opening for writing checks access without changing any bytes.
            with target.open('r+b'):
                pass
        except OSError as error:
            blocked.append((target, error))
    if blocked:
        print('\nBuild stopped: cannot replace an existing EXE.')
        for target, error in blocked:
            print(f'  {target}\n  {error}')
        print('\nClose FauxCode, including background instances in Task Manager,')
        print('then run .\\build.bat again. No processes were stopped automatically.')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
