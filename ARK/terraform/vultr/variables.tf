variable "name" {
  type        = string
  default     = "ark-echo"
  description = "Stable deployment name. Changing this can replace the VM."
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,40}$", var.name))
    error_message = "Use a lowercase name containing letters, digits and hyphens."
  }
}

variable "region" {
  type        = string
  default     = "ewr"
  description = "Vultr region slug. Availability is checked against the selected plan."
}

variable "plan" {
  type        = string
  default     = "vc2-2c-4gb"
  description = "CPU VM plan; 4 GB is recommended for building the simulator on the VM."
}

variable "ssh_public_key" {
  type        = string
  description = "Deployment SSH PUBLIC key only. The private key never enters Terraform."
  validation {
    condition     = can(regex("^ssh-(ed25519|rsa) ", var.ssh_public_key))
    error_message = "Supply an OpenSSH ed25519 or RSA public key."
  }
}

variable "ssh_cidr" {
  type        = string
  description = "Administrator IPv4 CIDR permitted to SSH, normally your public IP/32."
  validation {
    condition     = can(cidrnetmask(var.ssh_cidr)) && try(tonumber(split("/", var.ssh_cidr)[1]) >= 8, false)
    error_message = "Supply a valid IPv4 CIDR with prefix /8 or narrower; SSH is never open to the whole internet."
  }
}
