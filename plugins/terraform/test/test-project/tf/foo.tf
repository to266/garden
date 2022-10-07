variable "my-variable" {
  type = string
}

variable "env" {
  type = string
}

resource "local_file" "test-file" {
  content  = terraform.workspace
  filename = "${path.module}/test.log" # using .log extension so that it's ignored by git
}

output "test-file-path" {
  value = "${local_file.test-file.filename}"
}

output "my-output" {
  value = "workspace: ${terraform.workspace}, input: ${var.my-variable}"
}