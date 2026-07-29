pub type Matrix = Vec<Vec<f64>>;

pub fn cholesky(matrix: &Matrix) -> Result<Matrix, String> {
    let size = matrix.len();
    if size == 0 || matrix.iter().any(|row| row.len() != size) {
        return Err("Cholesky input must be a non-empty square matrix".to_owned());
    }
    let mut lower = vec![vec![0.0; size]; size];
    for row in 0..size {
        for column in 0..=row {
            let residual = matrix[row][column]
                - (0..column)
                    .map(|index| lower[row][index] * lower[column][index])
                    .sum::<f64>();
            if row == column {
                if residual <= 1e-20 || !residual.is_finite() {
                    return Err("mass matrix is not positive definite".to_owned());
                }
                lower[row][column] = residual.sqrt();
            } else {
                lower[row][column] = residual / lower[column][column];
            }
        }
    }
    Ok(lower)
}

pub fn solve_lower(lower: &Matrix, right: &[f64]) -> Vec<f64> {
    let mut result = vec![0.0; lower.len()];
    for row in 0..lower.len() {
        result[row] = (right[row]
            - (0..row)
                .map(|column| lower[row][column] * result[column])
                .sum::<f64>())
            / lower[row][row];
    }
    result
}

pub fn solve_upper_from_lower_transpose(lower: &Matrix, right: &[f64]) -> Vec<f64> {
    let size = lower.len();
    let mut result = vec![0.0; size];
    for row in (0..size).rev() {
        result[row] = (right[row]
            - (row + 1..size)
                .map(|column| lower[column][row] * result[column])
                .sum::<f64>())
            / lower[row][row];
    }
    result
}

#[allow(clippy::needless_range_loop)]
pub fn generalized_to_standard(
    stiffness: &Matrix,
    mass: &Matrix,
) -> Result<(Matrix, Matrix), String> {
    let lower = cholesky(mass)?;
    let size = mass.len();
    let mut left = vec![vec![0.0; size]; size];
    for column in 0..size {
        let right = (0..size)
            .map(|row| stiffness[row][column])
            .collect::<Vec<_>>();
        let solved = solve_lower(&lower, &right);
        for row in 0..size {
            left[row][column] = solved[row];
        }
    }
    let mut standard = vec![vec![0.0; size]; size];
    for row in 0..size {
        let solved = solve_lower(&lower, &left[row]);
        standard[row][..size].copy_from_slice(&solved[..size]);
    }
    for row in 0..size {
        for column in 0..row {
            let average = 0.5 * (standard[row][column] + standard[column][row]);
            standard[row][column] = average;
            standard[column][row] = average;
        }
    }
    Ok((standard, lower))
}

#[allow(clippy::needless_range_loop)]
pub fn jacobi_eigen_symmetric(
    matrix: &Matrix,
    relative_tolerance: f64,
    maximum_sweeps: usize,
) -> Result<(Vec<f64>, Matrix, usize, f64), String> {
    let size = matrix.len();
    let mut work = matrix.clone();
    let mut vectors = (0..size)
        .map(|row| {
            (0..size)
                .map(|column| if row == column { 1.0 } else { 0.0 })
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    let mut final_off_diagonal = f64::INFINITY;
    let mut completed_sweeps = 0;
    let mut converged = false;
    for sweep in 0..maximum_sweeps {
        let scale = work
            .iter()
            .enumerate()
            .map(|(index, row)| row[index].abs())
            .fold(1.0_f64, f64::max);
        final_off_diagonal = (0..size)
            .flat_map(|row| (row + 1..size).map(move |column| (row, column)))
            .map(|(row, column)| work[row][column].abs())
            .fold(0.0_f64, f64::max);
        if final_off_diagonal <= relative_tolerance * scale {
            completed_sweeps = sweep;
            converged = true;
            break;
        }
        for p in 0..size.saturating_sub(1) {
            for q in p + 1..size {
                let apq = work[p][q];
                if apq.abs() <= relative_tolerance * scale {
                    continue;
                }
                let tau = (work[q][q] - work[p][p]) / (2.0 * apq);
                let tangent = if tau >= 0.0 {
                    1.0 / (tau + (1.0 + tau * tau).sqrt())
                } else {
                    -1.0 / (-tau + (1.0 + tau * tau).sqrt())
                };
                let cosine = 1.0 / (1.0 + tangent * tangent).sqrt();
                let sine = tangent * cosine;
                let app = work[p][p];
                let aqq = work[q][q];
                work[p][p] = app - tangent * apq;
                work[q][q] = aqq + tangent * apq;
                work[p][q] = 0.0;
                work[q][p] = 0.0;
                for index in 0..size {
                    if index == p || index == q {
                        continue;
                    }
                    let aip = work[index][p];
                    let aiq = work[index][q];
                    work[index][p] = cosine * aip - sine * aiq;
                    work[p][index] = work[index][p];
                    work[index][q] = sine * aip + cosine * aiq;
                    work[q][index] = work[index][q];
                }
                for row in &mut vectors {
                    let vip = row[p];
                    let viq = row[q];
                    row[p] = cosine * vip - sine * viq;
                    row[q] = sine * vip + cosine * viq;
                }
            }
        }
        completed_sweeps = sweep + 1;
    }
    if !converged {
        return Err(format!(
            "Jacobi eigensolver did not converge after {maximum_sweeps} sweeps \
             (maximum off-diagonal {final_off_diagonal})"
        ));
    }
    Ok((
        (0..size).map(|index| work[index][index]).collect(),
        vectors,
        completed_sweeps,
        final_off_diagonal,
    ))
}

pub fn mass_inner(left: &[f64], mass: &Matrix, right: &[f64]) -> f64 {
    (0..left.len())
        .map(|row| {
            left[row]
                * (0..right.len())
                    .map(|column| mass[row][column] * right[column])
                    .sum::<f64>()
        })
        .sum()
}
