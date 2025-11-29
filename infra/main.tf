terraform {
  required_version = ">= 1.3.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile
}

# ---------------------------
# S3 bucket for admin portal
# ---------------------------

resource "aws_s3_bucket" "admin_portal" {
  bucket = var.admin_portal_bucket_name

  tags = {
    Project     = "TransVahan"
    Environment = var.environment
    Component   = "admin-portal"
  }
}

# Allow this bucket to be public (for static website)
resource "aws_s3_bucket_public_access_block" "admin_portal_public_access" {
  bucket = aws_s3_bucket.admin_portal.id

  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

# Static website hosting
resource "aws_s3_bucket_website_configuration" "admin_portal_website" {
  bucket = aws_s3_bucket.admin_portal.bucket

  index_document {
    suffix = "index.html"
  }

  error_document {
    key = "index.html"
  }
}

# Public read policy
data "aws_iam_policy_document" "admin_portal_policy" {
  statement {
    sid    = "PublicReadGetObject"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    actions = ["s3:GetObject"]

    resources = [
      "arn:aws:s3:::${aws_s3_bucket.admin_portal.bucket}/*"
    ]
  }
}

resource "aws_s3_bucket_policy" "admin_portal_policy" {
  bucket = aws_s3_bucket.admin_portal.id
  policy = data.aws_iam_policy_document.admin_portal_policy.json

  depends_on = [aws_s3_bucket_public_access_block.admin_portal_public_access]
}
