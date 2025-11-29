output "admin_portal_bucket_name" {
  value = aws_s3_bucket.admin_portal.id
}

output "admin_portal_website_endpoint" {
  value = aws_s3_bucket_website_configuration.admin_portal_website.website_endpoint
}
