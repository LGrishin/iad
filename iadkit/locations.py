"""Keep generated architecture data outside the shared toolkit."""

from pathlib import Path


def toolkit_directory():
    package = Path(__file__).resolve().parent
    checkout = package.parent
    if (checkout / "pyproject.toml").is_file() and (checkout / "iadkit").resolve() == package:
        return checkout
    return package


def require_external_directory(path, description):
    candidate = Path(path).expanduser().resolve()
    protected = toolkit_directory()
    if candidate == protected or candidate.is_relative_to(protected):
        raise ValueError(f"{description} must be outside the IAD toolkit; choose a separate diagram directory")
    return candidate
