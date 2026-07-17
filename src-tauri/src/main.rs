fn main() {
    if let Some(exit_code) = xiao_workbench_lib::run_runtime_supervisor_if_requested() {
        std::process::exit(exit_code);
    }
    xiao_workbench_lib::run();
}
