"""Small deterministic dense symmetric eigensolver (stdlib only)."""

from __future__ import annotations

import math

Matrix = list[list[float]]


def cholesky(matrix: Matrix) -> Matrix:
    size = len(matrix)
    lower = [[0.0] * size for _ in range(size)]
    for row in range(size):
        for column in range(row + 1):
            residual = matrix[row][column] - sum(
                lower[row][index] * lower[column][index] for index in range(column)
            )
            if row == column:
                if residual <= 1e-20:
                    raise ValueError("mass matrix is not positive definite")
                lower[row][column] = math.sqrt(residual)
            else:
                lower[row][column] = residual / lower[column][column]
    return lower


def solve_lower(lower: Matrix, right: list[float]) -> list[float]:
    result = [0.0] * len(lower)
    for row in range(len(lower)):
        result[row] = (
            right[row]
            - sum(lower[row][column] * result[column] for column in range(row))
        ) / lower[row][row]
    return result


def solve_upper_from_lower_transpose(lower: Matrix, right: list[float]) -> list[float]:
    size = len(lower)
    result = [0.0] * size
    for row in range(size - 1, -1, -1):
        result[row] = (
            right[row]
            - sum(lower[column][row] * result[column] for column in range(row + 1, size))
        ) / lower[row][row]
    return result


def generalized_to_standard(stiffness: Matrix, mass: Matrix) -> tuple[Matrix, Matrix]:
    """Return ``L^-1 K L^-T`` and the Cholesky factor ``L`` of ``M``."""

    lower = cholesky(mass)
    size = len(mass)
    left = [[0.0] * size for _ in range(size)]
    for column in range(size):
        solved = solve_lower(lower, [stiffness[row][column] for row in range(size)])
        for row in range(size):
            left[row][column] = solved[row]
    standard = [[0.0] * size for _ in range(size)]
    for row in range(size):
        solved = solve_lower(lower, left[row])
        for column in range(size):
            standard[row][column] = solved[column]
    for row in range(size):
        for column in range(row):
            average = 0.5 * (standard[row][column] + standard[column][row])
            standard[row][column] = average
            standard[column][row] = average
    return standard, lower


def jacobi_eigen_symmetric(
    matrix: Matrix,
    *,
    relative_tolerance: float = 1e-12,
    maximum_sweeps: int = 80,
) -> tuple[list[float], Matrix, int, float]:
    size = len(matrix)
    work = [row[:] for row in matrix]
    vectors = [[1.0 if row == column else 0.0 for column in range(size)] for row in range(size)]
    final_off_diagonal = math.inf
    completed_sweeps = 0
    for sweep in range(maximum_sweeps):
        scale = max(1.0, max(abs(work[index][index]) for index in range(size)))
        final_off_diagonal = max(
            (abs(work[row][column]) for row in range(size) for column in range(row + 1, size)),
            default=0.0,
        )
        if final_off_diagonal <= relative_tolerance * scale:
            completed_sweeps = sweep
            break
        for p in range(size - 1):
            for q in range(p + 1, size):
                apq = work[p][q]
                if abs(apq) <= relative_tolerance * scale:
                    continue
                tau = (work[q][q] - work[p][p]) / (2.0 * apq)
                tangent = (
                    1.0 / (tau + math.sqrt(1.0 + tau * tau))
                    if tau >= 0.0
                    else -1.0 / (-tau + math.sqrt(1.0 + tau * tau))
                )
                cosine = 1.0 / math.sqrt(1.0 + tangent * tangent)
                sine = tangent * cosine
                app = work[p][p]
                aqq = work[q][q]
                work[p][p] = app - tangent * apq
                work[q][q] = aqq + tangent * apq
                work[p][q] = 0.0
                work[q][p] = 0.0
                for index in range(size):
                    if index in {p, q}:
                        continue
                    aip = work[index][p]
                    aiq = work[index][q]
                    work[index][p] = cosine * aip - sine * aiq
                    work[p][index] = work[index][p]
                    work[index][q] = sine * aip + cosine * aiq
                    work[q][index] = work[index][q]
                for row in range(size):
                    vip = vectors[row][p]
                    viq = vectors[row][q]
                    vectors[row][p] = cosine * vip - sine * viq
                    vectors[row][q] = sine * vip + cosine * viq
        completed_sweeps = sweep + 1
    else:
        raise ValueError(
            f"Jacobi eigensolver did not converge after {maximum_sweeps} sweeps "
            f"(maximum off-diagonal {final_off_diagonal})"
        )
    return [work[index][index] for index in range(size)], vectors, completed_sweeps, final_off_diagonal


def mass_inner(left: list[float], mass: Matrix, right: list[float]) -> float:
    return sum(
        left[row] * sum(mass[row][column] * right[column] for column in range(len(right)))
        for row in range(len(left))
    )
