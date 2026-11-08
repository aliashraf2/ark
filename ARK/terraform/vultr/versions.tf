terraform {
  backend "local" {}
  required_version = ">= 1.7, < 2.0"
  required_providers {
    vultr = {
      source  = "vultr/vultr"
      version = "2.33.2"
    }
  }
}

# Read VULTR_API_KEY from the process environment. Do not put tokens in tfvars.
provider "vultr" {}
